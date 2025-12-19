// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);

const port = process.env.PORT || 10000;

// ============================
// IA (Gemini)
// ============================
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en variables de entorno.");

const ai = new GoogleGenAI({ apiKey });

// ============================
// Supabase
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log("✅ Supabase configurada: verdadero");
} else {
  console.warn("⚠️ Supabase NO configurado. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
}

// Middleware
app.use(cors());
app.use(express.json({ strict: false, limit: "1mb" }));

// ============================
// System instruction
// ============================
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial. Tu objetivo es proporcionar información precisa, completa y concisa sobre la Fundación Capacítamente (https://fundacioncapacitamente.com/) y sus actividades, además de responder preguntas de conocimiento general.

Utiliza la siguiente información para las consultas sobre la Fundación:
- Misión Principal: Ofrecer capacitación de alto valor en habilidades blandas y digitales esenciales para el desarrollo profesional y empresarial.
- Cursos con Certificado (Costo e Instructor):
  - Formador de Formadores ($120): Tatiana Arias.
  - Inteligencia Emocional ($15): Tatiana Arias.
  - TECNOLOGÍA PARA PADRES ($15): Yadira Suárez.
  - Contabilidad para no contadores (Próximamente - $20): E Arias.
  - Docencia Virtual (Próximamente - $20): Tatiana Arias.
  - Habilidades Cognitivas y Emocionales. Metodología Aprender a Pensar (Próximamente - $20): Tatiana Arias.
- Cursos Gratuitos:
  - Tecnología para Educadores: Tatiana Arias.
  - Metodología de la Pregunta (Próximamente): Tatiana Arias.
  - Neuroeducación… También en casa (Próximamente): Prosandoval.
- Contacto:
  - Celular: 0983222358
  - Correo: info@fundacioncapacitamente.com
  - Ubicación: Guayaquil - Ecuador
- Donaciones (Guía):
  1) Donaciones -> "Donar ahora"
  2) Elegir cantidad o personalizada -> "Continuar"
  3) Llenar datos
  4) Elegir método (Transferencia o PayPal)
  5) "Donar ahora"

Si la pregunta no es sobre la Fundación, usa tu conocimiento general.
`;

// ============================
// Helpers
// ============================
function getClientId(req) {
  // viene del frontend (localStorage)
  return String(req.body?.clientId || req.query?.clientId || req.headers["x-client-id"] || "").trim();
}

function getUserKey(req) {
  // Preferimos clientId (estable). Si no llega, fallback IP|UA.
  const clientId = getClientId(req);
  if (clientId) return `cid:${clientId}`.slice(0, 500);

  const ip = req.ip || "";
  const ua = req.headers["user-agent"] || "";
  return `${ip} | ${ua}`.slice(0, 500);
}

function newSessionId() {
  return `session-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function extractStatus(err) {
  return err?.status || err?.code || err?.error?.code || err?.response?.status || null;
}

function extractMessage(err) {
  if (typeof err?.message === "string") return err.message;
  try {
    return JSON.stringify(err?.error || err);
  } catch {
    return String(err);
  }
}

// ============================
// FAQ sin IA (pero guardado en historial)
// ============================
function faqReply(message) {
  const t = String(message || "").toLowerCase();

  if (t.includes("donaci") || t.includes("donar")) {
    return `Para donar:
1) Entra a Donaciones → "Donar ahora"
2) Elige una cantidad (o personalizada) → "Continuar"
3) Llena tus datos
4) Elige método (Transferencia o PayPal)
5) Presiona "Donar ahora"`;
  }

  if (t.includes("contact") || t.includes("inscrib") || t.includes("información") || t.includes("informacion")) {
    return `Contacto Fundación Capacítamente:
📱 0983222358
✉️ info@fundacioncapacitamente.com
📍 Guayaquil - Ecuador`;
  }

  if (
    t.includes("precio") ||
    t.includes("costo") ||
    (t.includes("curso") && (t.includes("pago") || t.includes("certif") || t.includes("certificado")))
  ) {
    return `Cursos con certificado:
• Formador de Formadores ($120) – Tatiana Arias
• Inteligencia Emocional ($15) – Tatiana Arias
• Tecnología para Padres ($15) – Yadira Suárez

Próximamente:
• Contabilidad para no contadores ($20)
• Docencia Virtual ($20)
• Habilidades Cognitivas y Emocionales (Aprender a Pensar) ($20)`;
  }

  if (t.includes("gratis") || t.includes("gratuito")) {
    return `Cursos gratuitos:
• Tecnología para Educadores – Tatiana Arias
Próximamente:
• Metodología de la Pregunta – Tatiana Arias
• Neuroeducación… También en casa – Prosandoval`;
  }

  return null;
}

// ============================
// Supabase helpers (sesiones / mensajes)
// ============================
async function ensureSession(sessionId, userKey) {
  if (!supabase) return;

  const now = new Date().toISOString();

  // ¿existe?
  const { data: existing, error: selErr } = await supabase
    .from("chat_sessions")
    .select("session_id, user_key")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (selErr) throw selErr;

  if (!existing) {
    const { error: insErr } = await supabase.from("chat_sessions").insert([
      {
        session_id: sessionId,
        user_key: userKey,
        last_seen: now,
        // last_message_at / preview se llenan cuando haya mensajes
      },
    ]);
    if (insErr) throw insErr;
  } else {
    // actualiza last_seen (sin cambiar owner)
    if (existing.user_key === userKey) {
      const { error: upErr } = await supabase
        .from("chat_sessions")
        .update({ last_seen: now })
        .eq("session_id", sessionId);
      if (upErr) throw upErr;
    }
  }
}

async function touchSessionLastMessage(sessionId, userKey, previewText) {
  if (!supabase) return;

  const now = new Date().toISOString();
  const preview = String(previewText || "").slice(0, 200);

  // Solo actualiza si el session pertenece a este userKey
  const { data: s, error: selErr } = await supabase
    .from("chat_sessions")
    .select("session_id, user_key")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (selErr) throw selErr;
  if (!s || s.user_key !== userKey) return;

  const { error: upErr } = await supabase
    .from("chat_sessions")
    .update({
      last_seen: now,
      last_message_at: now,
      last_message_preview: preview,
    })
    .eq("session_id", sessionId);

  if (upErr) throw upErr;
}

async function insertChatMessage(sessionId, role, content) {
  if (!supabase) return;

  const { error } = await supabase
    .from("chat_messages")
    .insert([{ session_id: sessionId, role, content }]);

  if (error) throw error;
}

// ============================
// Límite diario IA (opcional)
// ============================
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 300;

const MAX_DAILY_AI_CALLS = Number(process.env.MAX_DAILY_AI_CALLS || 50);
let aiCallsToday = 0;
let aiCallsDayKey = getDayKeyEC();

function getDayKeyEC() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function resetDailyIfNeeded() {
  const nowKey = getDayKeyEC();
  if (nowKey !== aiCallsDayKey) {
    aiCallsDayKey = nowKey;
    aiCallsToday = 0;
  }
}
function canUseAI() {
  resetDailyIfNeeded();
  return aiCallsToday < MAX_DAILY_AI_CALLS;
}
function incAI() {
  resetDailyIfNeeded();
  aiCallsToday++;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastAccess > SESSION_TTL_MS) sessions.delete(sid);
  }
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const extra = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < extra; i++) sessions.delete(ordered[i][0]);
  }
}, 60 * 1000);

// ============================
// Routes
// ============================
app.get("/health", (req, res) => res.status(200).send("ok"));

// Lista de conversaciones del usuario (para el recuadro)
app.get("/sessions", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado." });

    const userKey = getUserKey(req);
    const limit = Math.min(Number(req.query.limit || 30), 100);

    const { data, error } = await supabase
      .from("chat_sessions")
      .select("session_id, created_at, last_seen, last_message_at, last_message_preview")
      .eq("user_key", userKey)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ sessions: data || [] });
  } catch (e) {
    return res.status(500).json({ error: "Error en /sessions", details: String(e?.message || e) });
  }
});

// Crear nueva conversación (botón “Nueva”)
app.post("/sessions", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado." });

    const userKey = getUserKey(req);
    const sessionId = newSessionId();

    await ensureSession(sessionId, userKey);

    return res.json({ sessionId });
  } catch (e) {
    return res.status(500).json({ error: "Error creando sesión", details: String(e?.message || e) });
  }
});

// Historial de una conversación
app.get("/history/:sessionId", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado." });

    const userKey = getUserKey(req);
    const sessionId = String(req.params.sessionId || "").trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    // Validar que sea del mismo usuario
    const { data: s, error: sErr } = await supabase
      .from("chat_sessions")
      .select("session_id, user_key")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (sErr) return res.status(500).json({ error: sErr.message });
    if (!s || s.user_key !== userKey) return res.status(404).json({ error: "Sesión no encontrada." });

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ sessionId, messages: data || [] });
  } catch (e) {
    return res.status(500).json({ error: "Error en historial", details: String(e?.message || e) });
  }
});

// Chat principal
app.post("/chat", async (req, res) => {
  try {
    if (!apiKey) return res.status(500).json({ reply: "Servidor sin API KEY (GEMINI_API_KEY)." });

    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();

    if (!userMessage) return res.status(400).json({ reply: "Mensaje no proporcionado." });

    if (!sessionId) sessionId = newSessionId();

    const userKey = getUserKey(req);

    // 1) Asegura sesión y guarda mensaje usuario
    if (supabase) {
      await ensureSession(sessionId, userKey);
      await insertChatMessage(sessionId, "user", userMessage);
      await touchSessionLastMessage(sessionId, userKey, userMessage);
    }

    // 2) FAQ sin IA (pero se guarda)
    const faq = faqReply(userMessage);
    if (faq) {
      if (supabase) {
        await insertChatMessage(sessionId, "bot", faq);
        await touchSessionLastMessage(sessionId, userKey, faq);
      }
      res.set("Cache-Control", "no-store");
      return res.json({ reply: faq, sessionId });
    }

    // 3) Límite diario IA
    if (!canUseAI()) {
      const msg = `Hoy ya se alcanzó el límite diario de respuestas con IA (${MAX_DAILY_AI_CALLS}/día).
Puedes volver a intentar mañana o contactarnos por WhatsApp/Correo.`;

      if (supabase) {
        await insertChatMessage(sessionId, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return res.status(429).json({ reply: msg, sessionId });
    }

    // 4) Sesión IA en memoria
    let session = sessions.get(sessionId);
    if (!session) {
      const chat = ai.chats.create({
        model: "gemini-2.5-flash",
        config: {
          systemInstruction,
          temperature: 0.3,
          maxOutputTokens: 600,
        },
      });
      session = { chat, lastAccess: Date.now() };
      sessions.set(sessionId, session);
      console.log("🆕 Nueva sesión IA:", sessionId);
    } else {
      session.lastAccess = Date.now();
    }

    incAI();

    const response = await session.chat.sendMessage({ message: userMessage });
    const reply = typeof response.text === "string" ? response.text.trim() : "";

    if (!reply) {
      const msg = "La IA respondió vacío. Intenta nuevamente.";
      if (supabase) {
        await insertChatMessage(sessionId, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return res.status(502).json({ reply: msg, sessionId });
    }

    if (supabase) {
      await insertChatMessage(sessionId, "bot", reply);
      await touchSessionLastMessage(sessionId, userKey, reply);
    }

    res.set("Cache-Control", "no-store");
    return res.json({ reply, sessionId });
  } catch (error) {
    const status = extractStatus(error);
    const msg = extractMessage(error);
    console.error("❌ Error /chat:", msg);

    if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(msg)) {
      res.set("Retry-After", "60");
      return res.status(429).json({
        reply: "Se alcanzó el límite de uso del servicio de IA por hoy. Intenta más tarde o mañana.",
      });
    }

    return res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta más tarde." });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
});

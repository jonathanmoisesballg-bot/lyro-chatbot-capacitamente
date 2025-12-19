// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);

const port = process.env.PORT || 10000;

// --------------------
// CORS + JSON
// --------------------
app.use(cors({ origin: true }));
app.options("*", cors({ origin: true }));
app.use(express.json({ strict: false, limit: "1mb" }));

// --------------------
// Gemini
// --------------------
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en Render.");

const ai = new GoogleGenAI({ apiKey });

// --------------------
// Supabase
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn("⚠️ Supabase NO configurado. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
}

function safeStr(v, max = 500) {
  return String(v || "").slice(0, max);
}

// userKey estable (viene del FRONT). Si no viene, cae a ip+ua.
function getUserKey(req) {
  const bodyKey = safeStr(req.body?.userKey, 200);
  if (bodyKey) return bodyKey;

  const ip = safeStr(req.ip, 120);
  const ua = safeStr(req.headers["user-agent"], 300);
  return safeStr(`ip:${ip}|ua:${ua}`, 500);
}

async function upsertChatSession(sessionId, userKey) {
  if (!supabase) return;

  const { error } = await supabase
    .from("chat_sessions")
    .upsert(
      {
        session_id: sessionId,
        user_key: userKey,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    );

  if (error) console.warn("⚠️ Supabase upsert session error:", error.message);
}

async function insertChatMessage(sessionId, role, content) {
  if (!supabase) return;

  const { error } = await supabase
    .from("chat_messages")
    .insert([{ session_id: sessionId, role, content }]);

  if (error) console.warn("⚠️ Supabase insert message error:", error.message);
}

// --------------------
// Config sesiones IA en memoria
// --------------------
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

// --------------------
// System instruction
// --------------------
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

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => res.status(200).send("ok"));

// --------------------
// FAQ sin IA (para ahorrar cuota)
// --------------------
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

function extractStatus(err) {
  return err?.status || err?.code || err?.error?.code || err?.response?.status || null;
}
function extractMessage(err) {
  if (typeof err?.message === "string") return err.message;
  try { return JSON.stringify(err?.error || err); } catch { return String(err); }
}

// --------------------
// POST /chat  (guarda + responde)
// --------------------
app.post("/chat", async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ reply: "Servidor sin API KEY. Configura GEMINI_API_KEY en Render." });
    }

    const userMessage = safeStr(req.body?.message, 5000).trim();
    let sessionId = safeStr(req.body?.sessionId, 200).trim();

    if (!userMessage) return res.status(400).json({ reply: "Mensaje no proporcionado." });

    if (!sessionId) sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Guardar sesión y mensaje usuario
    const userKey = getUserKey(req);
    await upsertChatSession(sessionId, userKey);
    await insertChatMessage(sessionId, "user", userMessage);

    // FAQ sin IA
    const faq = faqReply(userMessage);
    if (faq) {
      await insertChatMessage(sessionId, "bot", faq);
      res.set("Cache-Control", "no-store");
      return res.json({ reply: faq, sessionId, userKey });
    }

    // Límite diario IA
    if (!canUseAI()) {
      const msg = `Hoy ya se alcanzó el límite diario de respuestas con IA (${MAX_DAILY_AI_CALLS}/día).
Puedes volver a intentar mañana o contactarnos por WhatsApp/Correo.`;
      await insertChatMessage(sessionId, "bot", msg);
      return res.status(429).json({ reply: msg, sessionId, userKey });
    }

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
    } else {
      session.lastAccess = Date.now();
    }

    incAI();

    const response = await session.chat.sendMessage({ message: userMessage });
    const reply = typeof response.text === "string" ? response.text.trim() : "";

    if (!reply) {
      const msg = "La IA respondió vacío. Intenta nuevamente.";
      await insertChatMessage(sessionId, "bot", msg);
      return res.status(502).json({ reply: msg, sessionId, userKey });
    }

    await insertChatMessage(sessionId, "bot", reply);
    res.set("Cache-Control", "no-store");
    return res.json({ reply, sessionId, userKey });

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

    return res.status(500).json({
      reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde.",
    });
  }
});

// --------------------
// GET /history/:sessionId   (RECOMENDADO)
// --------------------
app.get("/history/:sessionId", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado en el servidor." });

    const sessionId = safeStr(req.params.sessionId, 200).trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ sessionId, messages: data || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// --------------------
// GET /history?userKey=...  (COMPATIBLE con tu HTML viejo)
// - Busca la última sesión de ese userKey y devuelve mensajes
// --------------------
app.get("/history", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado en el servidor." });

    const userKey = safeStr(req.query.userKey, 200).trim();
    const sessionIdQ = safeStr(req.query.sessionId, 200).trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    let sessionId = sessionIdQ;

    if (!sessionId && userKey) {
      const { data: sess, error: errSess } = await supabase
        .from("chat_sessions")
        .select("session_id")
        .eq("user_key", userKey)
        .order("last_seen", { ascending: false })
        .limit(1);

      if (errSess) return res.status(500).json({ error: errSess.message });
      sessionId = sess?.[0]?.session_id || "";
    }

    if (!sessionId) return res.json({ sessionId: null, messages: [] });

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ sessionId, messages: data || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
});

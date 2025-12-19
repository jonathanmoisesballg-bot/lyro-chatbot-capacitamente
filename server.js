// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);

const port = process.env.PORT || 10000;

// ===== Gemini =====
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en variables de entorno.");

const ai = new GoogleGenAI({ apiKey });

// ===== Supabase =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log("✅ Supabase configurada: verdadero");
} else {
  console.warn("⚠️ Supabase NO configurado. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
}

// Safe wrapper (evita que el chat muera por errores de red)
async function safeSupabase(label, fn) {
  if (!supabase) return { data: null, error: "Supabase no configurado" };
  try {
    const result = await fn();
    if (result?.error) console.warn(`⚠️ ${label}:`, result.error.message || result.error);
    return result;
  } catch (e) {
    console.warn(`⚠️ ${label}:`, String(e?.message || e));
    return { data: null, error: e };
  }
}

function getUserKey(req) {
  // Preferimos el clientId enviado desde el navegador
  const clientId = String(req.body?.clientId || "").trim();
  if (clientId) return clientId.slice(0, 200);

  // Fallback (por si no llega clientId)
  const ip = req.ip || "";
  const ua = req.headers["user-agent"] || "";
  return `${ip} | ${ua}`.slice(0, 200);
}

async function upsertChatSession(sessionId, userKey) {
  return safeSupabase("upsert chat_sessions", () =>
    supabase.from("chat_sessions").upsert(
      {
        session_id: sessionId,
        user_key: userKey,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    )
  );
}

async function insertChatMessage(sessionId, role, content) {
  return safeSupabase("insert chat_messages", () =>
    supabase.from("chat_messages").insert([{ session_id: sessionId, role, content }])
  );
}

// ===== Limits & sessions (IA en memoria) =====
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

// ===== Middleware =====
app.use(cors());
app.use(express.json({ strict: false, limit: "1mb" }));

// ===== System instruction =====
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

// ===== Health =====
app.get("/health", (req, res) => res.status(200).send("ok"));

// ===== Debug Supabase =====
app.get("/debug/supabase", async (req, res) => {
  if (!supabase) return res.status(500).json({ ok: false, error: "Supabase no configurado" });

  const test = await safeSupabase("debug select chat_sessions", () =>
    supabase.from("chat_sessions").select("session_id, user_key, last_seen").limit(1)
  );

  if (test?.error) {
    return res.status(500).json({
      ok: false,
      supabaseUrl: SUPABASE_URL,
      error: "Supabase query error",
      details: String(test.error?.message || test.error),
    });
  }

  return res.json({
    ok: true,
    supabaseUrl: SUPABASE_URL,
    sample: test.data || [],
  });
});

// ===== FAQ (sin IA) =====
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
  try {
    return JSON.stringify(err?.error || err);
  } catch {
    return String(err);
  }
}

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ reply: "Servidor sin API KEY. Configura GEMINI_API_KEY en Render." });
    }

    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();

    if (!userMessage) return res.status(400).json({ reply: "Mensaje no proporcionado." });

    if (!sessionId) sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const userKey = getUserKey(req);

    // Guardar en Supabase (si falla, no rompe el chat)
    await upsertChatSession(sessionId, userKey);
    await insertChatMessage(sessionId, "user", userMessage);

    // FAQ sin IA
    const faq = faqReply(userMessage);
    if (faq) {
      await insertChatMessage(sessionId, "bot", faq);
      res.set("Cache-Control", "no-store");
      return res.json({ reply: faq, sessionId });
    }

    // Límite IA
    if (!canUseAI()) {
      const msg = `Hoy ya se alcanzó el límite diario de respuestas con IA (${MAX_DAILY_AI_CALLS}/día).
Puedes volver a intentar mañana o contactarnos por WhatsApp/Correo.`;

      await insertChatMessage(sessionId, "bot", msg);
      return res.status(429).json({ reply: msg, sessionId });
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
      console.log("🆕 Nueva sesión:", sessionId);
    } else {
      session.lastAccess = Date.now();
    }

    incAI();

    const response = await session.chat.sendMessage({ message: userMessage });
    const reply = typeof response.text === "string" ? response.text.trim() : "";

    if (!reply) {
      const msg = "La IA respondió vacío. Intenta nuevamente.";
      await insertChatMessage(sessionId, "bot", msg);
      return res.status(502).json({ reply: msg, sessionId });
    }

    await insertChatMessage(sessionId, "bot", reply);

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

    return res.status(500).json({
      reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde.",
    });
  }
});

// ===== HISTORIAL =====
// GET /history/<sessionId>?limit=200
app.get("/history/:sessionId", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase no configurado en el servidor." });

  try {
    const sessionId = String(req.params.sessionId || "").trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const result = await safeSupabase("history select chat_messages", () =>
      supabase
        .from("chat_messages")
        .select("id, role, content, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(limit)
    );

    if (result?.error) {
      return res.status(500).json({
        error: "Supabase query error",
        details: String(result.error?.message || result.error),
      });
    }

    return res.json({ sessionId, messages: result.data || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
});

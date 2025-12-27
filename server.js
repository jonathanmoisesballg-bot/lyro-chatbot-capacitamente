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
// CORS (IMPORTANTE: x-client-id)
// ============================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-client-id"],
  })
);
app.options("*", cors());

app.use(express.json({ strict: false, limit: "1mb" }));

// ============================
// IA (Gemini)
// ============================
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en variables de entorno.");

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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

// ============================
// System instruction (IA)
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
// Helpers generales
// ============================
function getClientId(req) {
  const h = String(req.headers["x-client-id"] || "").trim();
  const b = String(req.body?.clientId || "").trim();
  const q = String(req.query?.clientId || "").trim();
  return (h || b || q || "").slice(0, 120);
}

function getUserKey(req) {
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

function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function looksLikeCedulaEC(s) {
  const t = String(s || "").trim();
  return /^\d{10}$/.test(t);
}

// ============================
// MENÚ (sin IA)
// ============================
const MENU_TEXT =
`Hola 👋 Soy Lyro-Capacítamente. ¿En qué te puedo ayudar?

Responde con el número:
1. Cursos gratis
2. Cursos con certificados y precios
3. Contacto
4. Donar
5. Estado de certificado
6. Horarios`;

// ============================
// RESPUESTAS SIN IA
// ============================
function replyCursosGratis() {
  return `Cursos gratuitos:
• Tecnología para Educadores – Tatiana Arias

Próximamente:
• Metodología de la Pregunta – Tatiana Arias
• Neuroeducación… También en casa – Prosandoval`;
}

function replyCursosCert() {
  return `Cursos con certificado:
• Formador de Formadores ($120) – Tatiana Arias
• Inteligencia Emocional ($15) – Tatiana Arias
• Tecnología para Padres ($15) – Yadira Suárez

Próximamente:
• Contabilidad para no contadores ($20)
• Docencia Virtual ($20)
• Habilidades Cognitivas y Emocionales (Aprender a Pensar) ($20)`;
}

function replyContacto() {
  return `Contacto Fundación Capacítamente:
📱 0983222358
✉️ info@fundacioncapacitamente.com
📍 Guayaquil - Ecuador`;
}

function replyDonar() {
  return `Para donar:
1) Entra a Donaciones → "Donar ahora"
2) Elige una cantidad (o personalizada) → "Continuar"
3) Llena tus datos
4) Elige método (Transferencia o PayPal)
5) Presiona "Donar ahora"`;
}

function replyHorarios() {
  return `Los horarios son de manera como a usted le facilitaría recibir las clases, ya que son de modo online. ✅`;
}

// ============================
// Certificados (Opción A: consulta Supabase)
// ============================

// Mapea texto a curso_key para buscar en Supabase
const COURSE_MAP = [
  { match: ["formador de formadores", "formador", "formadores"], key: "formador_de_formadores" },
  { match: ["inteligencia emocional", "emocional"], key: "inteligencia_emocional" },
  { match: ["tecnologia para padres", "tecnología para padres", "padres"], key: "tecnologia_para_padres" },
  { match: ["tecnologia para educadores", "tecnología para educadores", "educadores"], key: "tecnologia_para_educadores" },
  { match: ["contabilidad para no contadores", "contabilidad"], key: "contabilidad_para_no_contadores" },
  { match: ["docencia virtual", "docencia"], key: "docencia_virtual" },
  { match: ["habilidades cognitivas", "aprender a pensar", "cognitivas"], key: "habilidades_cognitivas_emocionales" },
];

function detectCourseKeyFromText(message) {
  const t = normalizeText(message);
  for (const item of COURSE_MAP) {
    if (item.match.some(m => t.includes(normalizeText(m)))) {
      return item.key;
    }
  }
  return ""; // no detectado
}

async function lookupCertStatus(cedula, cursoKey) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("certificados_estado")
    .select("estado, detalle, updated_at")
    .eq("cedula", cedula)
    .eq("curso_key", cursoKey)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// Flujo por sesión (en RAM)
const certFlow = new Map(); 
// certFlow.get(sessionId) => { stage: "ASK_CEDULA"|"ASK_CURSO", cursoKey?: string, cedula?: string }

// ============================
// Supabase helpers (sesiones / mensajes)
// ============================
async function getSession(sessionId) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("chat_sessions")
    .select("session_id, user_key")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function ensureSession(sessionId, userKey) {
  if (!supabase) return;

  const now = new Date().toISOString();
  const existing = await getSession(sessionId);

  if (!existing) {
    const { error: insErr } = await supabase.from("chat_sessions").insert([
      { session_id: sessionId, user_key: userKey, last_seen: now },
    ]);
    if (insErr) throw insErr;
    return;
  }

  if (existing.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const { error: upErr } = await supabase
    .from("chat_sessions")
    .update({ last_seen: now })
    .eq("session_id", sessionId);

  if (upErr) throw upErr;
}

async function touchSessionLastMessage(sessionId, userKey, previewText) {
  if (!supabase) return;

  const now = new Date().toISOString();
  const preview = String(previewText || "").slice(0, 200);

  const s = await getSession(sessionId);
  if (!s || s.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const { error: upErr } = await supabase
    .from("chat_sessions")
    .update({ last_seen: now, last_message_at: now, last_message_preview: preview })
    .eq("session_id", sessionId);

  if (upErr) throw upErr;
}

async function insertChatMessage(sessionId, userKey, role, content) {
  if (!supabase) return;

  const s = await getSession(sessionId);
  if (!s || s.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

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
function canUseAI() { resetDailyIfNeeded(); return aiCallsToday < MAX_DAILY_AI_CALLS; }
function incAI() { resetDailyIfNeeded(); aiCallsToday++; }

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

// Lista de conversaciones
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

    res.set("Cache-Control", "no-store");
    return res.json({ sessions: data || [] });
  } catch (e) {
    return res.status(500).json({ error: "Error en /sessions", details: String(e?.message || e) });
  }
});

// Crear nueva conversación
app.post("/sessions", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado." });

    const userKey = getUserKey(req);
    const sessionId = newSessionId();
    const now = new Date().toISOString();

    const { error: insErr } = await supabase.from("chat_sessions").insert([
      { session_id: sessionId, user_key: userKey, last_seen: now },
    ]);
    if (insErr) throw insErr;

    // limpiar flow certificados para esta session (por si acaso)
    certFlow.delete(sessionId);

    res.set("Cache-Control", "no-store");
    return res.json({ sessionId });
  } catch (e) {
    return res.status(500).json({ error: "Error creando sesión", details: String(e?.message || e) });
  }
});

// Eliminar conversación
app.delete("/session/:sessionId", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado." });

    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "Falta sessionId" });

    const userKey = getUserKey(req);

    const s = await getSession(sessionId);
    if (!s) return res.status(404).json({ error: "Sesión no encontrada." });
    if (s.user_key !== userKey) return res.status(403).json({ error: "No autorizado para borrar esta sesión." });

    const { error: mErr } = await supabase.from("chat_messages").delete().eq("session_id", sessionId);
    if (mErr) return res.status(500).json({ error: "Error borrando mensajes", details: mErr.message });

    const { error: dErr } = await supabase.from("chat_sessions").delete().eq("session_id", sessionId);
    if (dErr) return res.status(500).json({ error: "Error borrando sesión", details: dErr.message });

    sessions.delete(sessionId);
    certFlow.delete(sessionId);

    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, sessionId });
  } catch (e) {
    const status = extractStatus(e) || 500;
    return res.status(status).json({ error: "Error interno", details: String(e?.message || e) });
  }
});

// Historial de una conversación
app.get("/history/:sessionId", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase no configurado." });

    const userKey = getUserKey(req);
    const sessionId = String(req.params.sessionId || "").trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const s = await getSession(sessionId);
    if (!s || s.user_key !== userKey) return res.status(404).json({ error: "Sesión no encontrada." });

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    res.set("Cache-Control", "no-store");
    return res.json({ sessionId, messages: data || [] });
  } catch (e) {
    return res.status(500).json({ error: "Error en historial", details: String(e?.message || e) });
  }
});

// ============================
// Chat principal
// ============================
app.post("/chat", async (req, res) => {
  try {
    if (!ai) return res.status(500).json({ reply: "Servidor sin API KEY (GEMINI_API_KEY)." });

    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();
    if (!userMessage) return res.status(400).json({ reply: "Mensaje no proporcionado." });

    if (!sessionId) sessionId = newSessionId();

    const userKey = getUserKey(req);

    // 1) Asegura sesión (si es ajena => 403)
    if (supabase) await ensureSession(sessionId, userKey);

    // 2) guarda msg usuario
    if (supabase) {
      await insertChatMessage(sessionId, userKey, "user", userMessage);
      await touchSessionLastMessage(sessionId, userKey, userMessage);
    }

    // =========================================================
    // 3) FLUJO: CERTIFICADO (sin IA)
    // =========================================================
    const norm = normalizeText(userMessage);

    // Si ya está en flujo
    if (certFlow.has(sessionId)) {
      const st = certFlow.get(sessionId);

      // Esperando cédula
      if (st.stage === "ASK_CEDULA") {
        const ced = userMessage.replace(/\s+/g, "");
        if (!looksLikeCedulaEC(ced)) {
          const msg = "Por favor escribe una cédula válida (10 dígitos). Ej: 0912345678";
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", msg);
            await touchSessionLastMessage(sessionId, userKey, msg);
          }
          return res.json({ reply: msg, sessionId });
        }

        st.cedula = ced;

        // Si ya teníamos curso detectado, consultamos directo
        if (st.cursoKey) {
          const row = await lookupCertStatus(st.cedula, st.cursoKey);

          let reply = "";
          if (!row) {
            reply = `No tengo registro del certificado para:\n• Cédula: ${st.cedula}\n• Curso: ${st.cursoKey}\n\nSi crees que es un error, escríbenos por WhatsApp o correo.`;
          } else {
            const det = row.detalle ? `\nDetalle: ${row.detalle}` : "";
            reply =
              row.estado === "LISTO"
                ? `✅ Tu certificado está LISTO.${det}`
                : row.estado === "EN_PROCESO"
                ? `⏳ Tu certificado está EN PROCESO.${det}`
                : `❌ Tu certificado NO ESTÁ LISTO.${det}`;
          }

          certFlow.delete(sessionId);

          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          res.set("Cache-Control", "no-store");
          return res.json({ reply, sessionId });
        }

        // Si no hay curso, pedirlo
        st.stage = "ASK_CURSO";
        certFlow.set(sessionId, st);

        const ask = `Perfecto ✅ Ahora escribe el nombre del curso.\nEj: "Inteligencia Emocional"`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", ask);
          await touchSessionLastMessage(sessionId, userKey, ask);
        }
        return res.json({ reply: ask, sessionId });
      }

      // Esperando curso
      if (st.stage === "ASK_CURSO") {
        const cursoKey = detectCourseKeyFromText(userMessage) || normalizeText(userMessage).replace(/\s+/g, "_");
        st.cursoKey = cursoKey;

        const row = await lookupCertStatus(st.cedula, st.cursoKey);

        let reply = "";
        if (!row) {
          reply = `No tengo registro del certificado para:\n• Cédula: ${st.cedula}\n• Curso: ${st.cursoKey}\n\nSi crees que es un error, escríbenos por WhatsApp o correo.`;
        } else {
          const det = row.detalle ? `\nDetalle: ${row.detalle}` : "";
          reply =
            row.estado === "LISTO"
              ? `✅ Tu certificado está LISTO.${det}`
              : row.estado === "EN_PROCESO"
              ? `⏳ Tu certificado está EN PROCESO.${det}`
              : `❌ Tu certificado NO ESTÁ LISTO.${det}`;
        }

        certFlow.delete(sessionId);

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        res.set("Cache-Control", "no-store");
        return res.json({ reply, sessionId });
      }
    }

    // =========================================================
    // 4) RESPUESTAS SIN IA (MENÚ + NÚMEROS + HORARIOS + BOTONES)
    // =========================================================

    // Saludo -> muestra menú
    const isGreeting =
      norm === "hola" || norm === "buenas" || norm === "buenos dias" || norm === "buenas tardes" || norm === "buenas noches" ||
      norm === "hey" || norm === "hi";

    if (isGreeting) {
      const reply = MENU_TEXT;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    // Números del menú
    if (["1","2","3","4","5","6"].includes(norm)) {
      let reply = "";
      if (norm === "1") reply = replyCursosGratis();
      if (norm === "2") reply = replyCursosCert();
      if (norm === "3") reply = replyContacto();
      if (norm === "4") reply = replyDonar();
      if (norm === "6") reply = replyHorarios();

      // opción 5: Estado de certificado (inicia flujo)
      if (norm === "5") {
        certFlow.set(sessionId, { stage: "ASK_CEDULA", cursoKey: "" });
        reply = "✅ Estado de certificado\nPor favor escribe tu número de cédula (10 dígitos). Ej: 0912345678";
      }

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    // Botones (texto)
    if (norm.includes("horario")) {
      const reply = replyHorarios();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    // “Estado de certificado” por texto o por intención
    if (norm.includes("estado de certificado") || norm.includes("certificado")) {
      const cursoKey = detectCourseKeyFromText(userMessage); // si detecta curso, lo guarda para pedir solo cédula
      certFlow.set(sessionId, { stage: "ASK_CEDULA", cursoKey });

      const reply = cursoKey
        ? `✅ Para consultar tu certificado (${cursoKey}) escribe tu número de cédula (10 dígitos). Ej: 0912345678`
        : `✅ Estado de certificado\nEscribe tu número de cédula (10 dígitos). Ej: 0912345678`;

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    // FAQ clásica (sin IA)
    // (para no gastar cuota y que también sirva si escriben el texto)
    if (norm.includes("donar") || norm.includes("donacion")) {
      const reply = replyDonar();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    if (norm.includes("contacto") || norm.includes("inscrip") || norm.includes("informacion")) {
      const reply = replyContacto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    if (norm.includes("gratis") || norm.includes("gratuito")) {
      const reply = replyCursosGratis();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    if (norm.includes("precio") || norm.includes("costo") || norm.includes("certificado") || (norm.includes("curso") && norm.includes("pago"))) {
      const reply = replyCursosCert();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return res.json({ reply, sessionId });
    }

    // =========================================================
    // 5) SI NO SE PUDO: IA
    // =========================================================
    if (!canUseAI()) {
      const msg = `Hoy ya se alcanzó el límite diario de respuestas con IA (${MAX_DAILY_AI_CALLS}/día).
Puedes volver a intentar mañana o contactarnos por WhatsApp/Correo.`;

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return res.status(429).json({ reply: msg, sessionId });
    }

    let session = sessions.get(sessionId);
    if (!session) {
      const chat = ai.chats.create({
        model: GEMINI_MODEL,
        config: { systemInstruction, temperature: 0.3, maxOutputTokens: 600 },
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
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return res.status(502).json({ reply: msg, sessionId });
    }

    if (supabase) {
      await insertChatMessage(sessionId, userKey, "bot", reply);
      await touchSessionLastMessage(sessionId, userKey, reply);
    }

    res.set("Cache-Control", "no-store");
    return res.json({ reply, sessionId });

  } catch (error) {
    const status = extractStatus(error);
    const msg = extractMessage(error);
    console.error("❌ Error /chat:", msg);

    if (status === 403) {
      return res.status(403).json({
        reply: "Esta conversación no te pertenece. Crea una nueva (botón Nueva).",
        sessionId: "",
      });
    }

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

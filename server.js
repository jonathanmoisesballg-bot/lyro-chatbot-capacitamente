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
// CONFIGURACIÓN (Límites Altos)
// ============================
const MAX_DAILY_AI_CALLS = 10000; // Límite alto para evitar bloqueos

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.error("❌ Falta GEMINI_API_KEY.");

const ai = new GoogleGenAI({ apiKey });

// ============================
// Supabase
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log("✅ Supabase configurada correctamente");
} else {
  console.warn("⚠️ Supabase NO configurado.");
}

app.use(cors());
app.use(express.json({ strict: false, limit: "1mb" }));

// ============================
// CEREBRO IA (TODA TU INFORMACIÓN AQUÍ)
// ============================
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial. Tu objetivo es proporcionar información precisa sobre la Fundación Capacítamente.

INFORMACIÓN CLAVE PARA RESPONDER:

1. Misión Principal: Ofrecer capacitación de alto valor en habilidades blandas y digitales esenciales para el desarrollo profesional y empresarial.

2. Cursos con Certificado (Costo e Instructor):
  - Formador de Formadores ($120): Tatiana Arias.
  - Inteligencia Emocional ($15): Tatiana Arias.
  - TECNOLOGÍA PARA PADRES ($15): Yadira Suárez.
  - Contabilidad para no contadores (Próximamente - $20): E Arias.
  - Docencia Virtual (Próximamente - $20): Tatiana Arias.
  - Habilidades Cognitivas y Emocionales. Metodología Aprender a Pensar (Próximamente - $20): Tatiana Arias.

3. Cursos Gratuitos:
  - Tecnología para Educadores: Tatiana Arias.
  - Metodología de la Pregunta (Próximamente): Tatiana Arias.
  - Neuroeducación… También en casa (Próximamente): Prosandoval.

4. Contacto:
  - Celular: 0983222358
  - Correo: info@fundacioncapacitamente.com
  - Ubicación: Guayaquil - Ecuador

5. Donaciones (Guía paso a paso):
  1) Ir a Donaciones -> "Donar ahora"
  2) Elegir cantidad o personalizada -> "Continuar"
  3) Llenar datos
  4) Elegir método (Transferencia o PayPal)
  5) "Donar ahora"

REGLA ESPECIAL (CERTIFICADOS):
Si el usuario pregunta si su certificado está listo, dile: "Por favor, escribe tu número de cédula (10 dígitos) para verificarlo en el sistema inmediatamente."
`;

// ============================
// Helpers
// ============================
function getUserKey(req) {
  const clientId = String(req.body?.clientId || req.headers["x-client-id"] || "").trim();
  if (clientId) return `cid:${clientId}`.slice(0, 500);
  return `${req.ip}-${req.headers["user-agent"]}`.slice(0, 500);
}

function newSessionId() {
  return `session-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

async function buscarCertificados(cedula) {
  if (!supabase) return "Error: No hay conexión con la base de datos.";
  
  const { data, error } = await supabase
    .from('certificados')
    .select('*')
    .eq('cedula', cedula);

  if (error) {
    console.error("Error DB:", error);
    return "Hubo un error técnico consultando. Intenta más tarde.";
  }

  if (!data || data.length === 0) {
    return `No encontré ningún registro para la cédula ${cedula}. Verifica el número o contacta a soporte.`;
  }

  const nombre = data[0].nombre_estudiante || "Estudiante";
  let respuesta = `Hola **${nombre}**, aquí está el estado de tus cursos:\n`;
  
  data.forEach((item, index) => {
    let icono = item.estado.toUpperCase().includes("LISTO") ? "✅" : "⏳";
    respuesta += `\n${index + 1}. ${item.curso}\n   Estado: ${item.estado} ${icono}`;
  });

  return respuesta;
}

// ============================
// Gestión de Sesiones
// ============================
async function ensureSession(sessionId, userKey) {
  if (!supabase) return;
  const now = new Date().toISOString();
  const { data } = await supabase.from("chat_sessions").select("session_id, user_key").eq("session_id", sessionId).maybeSingle();
  if (!data) {
    await supabase.from("chat_sessions").insert([{ session_id: sessionId, user_key: userKey, last_seen: now }]);
  } else if (data.user_key === userKey) {
    await supabase.from("chat_sessions").update({ last_seen: now }).eq("session_id", sessionId);
  }
}

async function saveMessage(sessionId, role, content, userKey) {
  if (!supabase) return;
  await supabase.from("chat_messages").insert([{ session_id: sessionId, role, content }]);
  await supabase.from("chat_sessions").update({ 
    last_seen: new Date().toISOString(), 
    last_message_at: new Date().toISOString(), 
    last_message_preview: content.slice(0, 100) 
  }).eq("session_id", sessionId);
}

let aiCallsToday = 0;
let aiCallsDayKey = new Date().toLocaleDateString();

// ============================
// RUTAS
// ============================
app.get("/health", (req, res) => res.send("ok"));

app.delete("/session/:sessionId", async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Sin DB" });
    const { sessionId } = req.params;
    await supabase.from("chat_messages").delete().eq("session_id", sessionId);
    await supabase.from("chat_sessions").delete().eq("session_id", sessionId);
    return res.json({ ok: true });
});

app.get("/sessions", async (req, res) => {
    if (!supabase) return res.json({ sessions: [] });
    const userKey = getUserKey(req);
    const { data } = await supabase.from("chat_sessions").select("*").eq("user_key", userKey).order("last_message_at", { ascending: false }).limit(30);
    return res.json({ sessions: data || [] });
});

app.get("/history/:sessionId", async (req, res) => {
    if (!supabase) return res.json({ messages: [] });
    const { data } = await supabase.from("chat_messages").select("*").eq("session_id", req.params.sessionId).order("created_at", { ascending: true });
    return res.json({ messages: data || [] });
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) sessionId = newSessionId();
    const userKey = getUserKey(req);

    if (!userMessage) return res.status(400).json({ reply: "..." });

    // 1. Guardar mensaje
    await ensureSession(sessionId, userKey);
    await saveMessage(sessionId, "user", userMessage, userKey);

    // 2. ¿Es cédula? (Intercepción)
    if (/^\d{10}$/.test(userMessage)) {
       const respuestaDB = await buscarCertificados(userMessage);
       await saveMessage(sessionId, "bot", respuestaDB, userKey);
       return res.json({ reply: respuestaDB, sessionId });
    }

    // 3. Control Límite
    const today = new Date().toLocaleDateString();
    if (today !== aiCallsDayKey) { aiCallsDayKey = today; aiCallsToday = 0; }
    
    if (aiCallsToday >= MAX_DAILY_AI_CALLS) {
      const msg = "Límite diario alcanzado. Intenta mañana.";
      await saveMessage(sessionId, "bot", msg, userKey);
      return res.status(429).json({ reply: msg, sessionId });
    }

    // 4. IA (Método seguro texto simple)
    const chat = ai.chats.create({
      model: "gemini-2.0-flash",
      config: { systemInstruction, temperature: 0.3 },
    });
    
    aiCallsToday++;
    
    // Enviamos el mensaje como string simple para evitar errores de versión
    const result = await chat.sendMessage(userMessage);
    
    // Extraemos la respuesta con seguridad
    const reply = result.response?.text?.() || result.response?.text || "No entendí tu pregunta.";

    await saveMessage(sessionId, "bot", reply, userKey);
    return res.json({ reply, sessionId });

  } catch (error) {
    console.error("Error en chat:", error);
    return res.status(500).json({ reply: "Lo siento, tuve un problema interno. Inténtalo de nuevo." });
  }
});

app.listen(port, () => console.log(`✅ Servidor puerto ${port}`));
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
// CONFIGURACIÓN (Límites y API)
// ============================
// Aumentamos el límite a 10,000 para que no te salga el Error 429
const MAX_DAILY_AI_CALLS = 10000; 

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.error("❌ Falta GEMINI_API_KEY en variables de entorno.");

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
// Cerebro de la IA
// ============================
const systemInstruction = `
Eres Lyro-Capacítamente, el asistente de la Fundación Capacítamente.
Tu tono es amable, profesional y directo.

INSTRUCCIONES CLAVE:
1. Si te saludan ("Hola"), preséntate y di: "¡Hola! Soy Lyro. ¿En qué puedo ayudarte? Si deseas consultar tus certificados, por favor escribe tu número de cédula."
2. Si preguntan por certificados, diles: "Por favor, ingresa tu número de cédula (10 dígitos) para verificar en el sistema."
3. Información general (solo si preguntan):
   - Cursos: Formador de Formadores ($120), Inteligencia Emocional ($15).
   - Ubicación: Guayaquil.
   - Contacto: 0983222358.

NOTA: Si el usuario envía un número de cédula, NO lo inventes. El sistema lo buscará automáticamente.
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

// ============================
// Lógica: BUSCAR EN SUPABASE (Cualquier cédula)
// ============================
async function buscarCertificados(cedula) {
  if (!supabase) return "Error: No hay conexión con la base de datos.";
  
  // Busca en la tabla que creamos en el Paso 1
  const { data, error } = await supabase
    .from('certificados')
    .select('*')
    .eq('cedula', cedula);

  if (error) {
    console.error("Error DB:", error);
    return "Hubo un error técnico consultando tu cédula. Intenta más tarde.";
  }

  // Si la lista está vacía, significa que esa cédula NO está registrada
  if (!data || data.length === 0) {
    return `Lo siento, no encontré registros para la cédula ${cedula}. 
Por favor verifica que esté bien escrita o contáctanos al WhatsApp 0983222358 si crees que es un error.`;
  }

  // Si encuentra datos, arma el mensaje bonito
  const nombre = data[0].nombre_estudiante || "Estudiante";
  let respuesta = `Hola **${nombre}**, he encontrado la siguiente información sobre tus cursos:\n`;
  
  data.forEach((item, index) => {
    // Pone un emoji dependiendo del estado
    let icono = "⏳";
    if (item.estado.toUpperCase().includes("LISTO")) icono = "✅";
    if (item.estado.toUpperCase().includes("PENDIENTE")) icono = "💰";

    respuesta += `\n**${index + 1}. ${item.curso}**\n   Estado: ${item.estado} ${icono}`;
  });

  respuesta += `\n\nSi tu certificado está listo, puedes acercarte a secretaría o escribirnos para el envío digital.`;
  return respuesta;
}

// ============================
// Gestión de Historial
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

// Límite diario (Control simple)
let aiCallsToday = 0;
let aiCallsDayKey = new Date().toLocaleDateString();

// ============================
// RUTAS (Endpoints)
// ============================
app.get("/health", (req, res) => res.send("ok"));

// 1. Eliminar conversación (Solución Error 404)
app.delete("/session/:sessionId", async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Sin DB" });
    const { sessionId } = req.params;
    
    // Borrar mensajes y sesión
    await supabase.from("chat_messages").delete().eq("session_id", sessionId);
    await supabase.from("chat_sessions").delete().eq("session_id", sessionId);
    
    return res.json({ ok: true });
});

// 2. Obtener lista de sesiones
app.get("/sessions", async (req, res) => {
    if (!supabase) return res.json({ sessions: [] });
    const userKey = getUserKey(req);
    const { data } = await supabase.from("chat_sessions").select("*").eq("user_key", userKey).order("last_message_at", { ascending: false }).limit(30);
    return res.json({ sessions: data || [] });
});

// 3. Obtener historial de un chat
app.get("/history/:sessionId", async (req, res) => {
    if (!supabase) return res.json({ messages: [] });
    const { data } = await supabase.from("chat_messages").select("*").eq("session_id", req.params.sessionId).order("created_at", { ascending: true });
    return res.json({ messages: data || [] });
});

// 4. CHAT PRINCIPAL (Aquí ocurre la magia)
app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) sessionId = newSessionId();
    const userKey = getUserKey(req);

    if (!userMessage) return res.status(400).json({ reply: "..." });

    // Guardar mensaje del usuario
    await ensureSession(sessionId, userKey);
    await saveMessage(sessionId, "user", userMessage, userKey);

    // --- DETECTOR DE CÉDULA ---
    // Si el mensaje son exactamente 10 números...
    if (/^\d{10}$/.test(userMessage)) {
       // Buscar en Supabase (NO usa créditos de IA)
       const respuestaDB = await buscarCertificados(userMessage);
       
       await saveMessage(sessionId, "bot", respuestaDB, userKey);
       return res.json({ reply: respuestaDB, sessionId });
    }
    // ---------------------------

    // Control de límite diario
    const today = new Date().toLocaleDateString();
    if (today !== aiCallsDayKey) { aiCallsDayKey = today; aiCallsToday = 0; }
    
    if (aiCallsToday >= MAX_DAILY_AI_CALLS) {
      const msg = "Límite diario alcanzado. Por favor intenta mañana.";
      await saveMessage(sessionId, "bot", msg, userKey);
      return res.status(429).json({ reply: msg, sessionId });
    }

    // Usar IA (Gemini)
    const chat = ai.chats.create({
      model: "gemini-2.0-flash",
      config: { systemInstruction, temperature: 0.3 },
    });
    
    aiCallsToday++;
    const result = await chat.sendMessage(userMessage); // Modo stateless simple para evitar errores de memoria
    const reply = result.response.text();

    await saveMessage(sessionId, "bot", reply, userKey);
    return res.json({ reply, sessionId });

  } catch (error) {
    console.error("Error en chat:", error);
    return res.status(500).json({ reply: "Error interno del servidor." });
  }
});

app.listen(port, () => console.log(`✅ Servidor corriendo en puerto ${port}`));
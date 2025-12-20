require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
// Importamos la librería. Si falla, asegúrate de que esté instalada.
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);

const port = process.env.PORT || 10000;

// ============================
// CONFIGURACIÓN
// ============================
const MAX_DAILY_AI_CALLS = 10000; // Límite alto

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
// INFORMACIÓN DEL BOT (TEXTO)
// ============================
const infoTexto = `
Eres Lyro-Capacítamente, asistente de la Fundación Capacítamente.

INFORMACIÓN CLAVE:
1. Cursos con Certificado:
  - Formador de Formadores ($120) - Prof. Tatiana Arias
  - Inteligencia Emocional ($15) - Prof. Tatiana Arias
  - Tecnología para Padres ($15) - Prof. Yadira Suárez
  - Próximamente: Contabilidad ($20), Docencia Virtual ($20).

2. Cursos Gratuitos:
  - Tecnología para Educadores.
  - Próximamente: Metodología de la Pregunta, Neuroeducación.

3. Donaciones:
  - Pasos: Ir a "Donar ahora" -> Elegir monto -> Llenar datos -> Elegir método (Transferencia/PayPal).

4. Contacto:
  - Celular: 0983222358
  - Ubicación: Guayaquil, Ecuador.

REGLA CERTIFICADOS:
Si preguntan por certificados, responde: "Por favor, escribe tu número de cédula (10 dígitos) para verificarlo."
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
    return "Error técnico consultando. Intenta más tarde.";
  }

  if (!data || data.length === 0) {
    return `No encontré registros para la cédula ${cedula}. Verifica el número.`;
  }

  const nombre = data[0].nombre_estudiante || "Estudiante";
  let respuesta = `Hola **${nombre}**, estado de tus cursos:\n`;
  
  data.forEach((item, index) => {
    let icono = item.estado.toUpperCase().includes("LISTO") ? "✅" : "⏳";
    respuesta += `\n${index + 1}. ${item.curso} - ${item.estado} ${icono}`;
  });

  return respuesta;
}

// ============================
// Gestión Sesiones
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
    try {
      await supabase.from("chat_messages").delete().eq("session_id", sessionId);
      await supabase.from("chat_sessions").delete().eq("session_id", sessionId);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
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

    // 1. Guardar mensaje usuario
    await ensureSession(sessionId, userKey);
    await saveMessage(sessionId, "user", userMessage, userKey);

    // 2. ¿Es cédula? (10 números)
    if (/^\d{10}$/.test(userMessage)) {
       const respuestaDB = await buscarCertificados(userMessage);
       await saveMessage(sessionId, "bot", respuestaDB, userKey);
       return res.json({ reply: respuestaDB, sessionId });
    }

    // 3. Control Límite
    const today = new Date().toLocaleDateString();
    if (today !== aiCallsDayKey) { aiCallsDayKey = today; aiCallsToday = 0; }
    if (aiCallsToday >= MAX_DAILY_AI_CALLS) {
      const msg = "Límite diario alcanzado.";
      await saveMessage(sessionId, "bot", msg, userKey);
      return res.status(429).json({ reply: msg, sessionId });
    }

    // 4. IA - CONFIGURACIÓN BLINDADA
    // Usamos gemini-1.5-flash que es más estable
    const chat = ai.chats.create({
      model: "gemini-1.5-flash",
      config: {
        // Enviar instrucciones en formato estricto
        systemInstruction: {
            parts: [{ text: infoTexto }]
        },
        temperature: 0.3,
      },
    });
    
    aiCallsToday++;
    
    // Enviar mensaje en formato estricto { parts: [...] }
    const result = await chat.sendMessage({
      parts: [{ text: userMessage }]
    });
    
    // Obtener respuesta con seguridad
    let reply = "No entendí.";
    if (result.response && result.response.text) {
        // La librería nueva a veces devuelve text() como función o como propiedad
        reply = typeof result.response.text === 'function' 
                ? result.response.text() 
                : result.response.text;
    }

    await saveMessage(sessionId, "bot", reply, userKey);
    return res.json({ reply, sessionId });

  } catch (error) {
    console.error("❌ Error CHAT:", error);
    // IMPORTANTE: Responder con error JSON en lugar de colgarse
    return res.status(500).json({ 
        reply: "Lo siento, tuve un error técnico. Por favor intenta de nuevo en unos segundos.",
        error: String(error)
    });
  }
});

app.listen(port, () => console.log(`✅ Servidor puerto ${port}`));
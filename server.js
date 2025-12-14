// server.js (RECOMENDADO con @google/genai)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = process.env.PORT || 10000;

// Acepta cualquiera de las dos variables (por si en Render usas GOOGLE_API_KEY)
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en variables de entorno.");
}

// Cliente único
const ai = new GoogleGenAI({ apiKey });

// Sesiones en memoria (simple)
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_SESSIONS = 300;

// Limpieza automática para que no se coma la RAM
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

// Middleware
app.use(cors());
app.use(express.json({ strict: false, limit: '1mb' }));

// ✅ TU TEXTO EXACTO (System Instruction)
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

// ✅ Respuestas rápidas (no consumen IA)
function faqReply(text) {
  const t = (text || "").toLowerCase();

  // Cursos con certificado (pago)
  if (
    (t.includes("curso") || t.includes("cursos")) &&
    (t.includes("pago") || t.includes("precio") || t.includes("precios") || t.includes("costo") || t.includes("cuesta"))
  ) {
    return `Cursos con Certificado:
- Formador de Formadores ($120): Tatiana Arias.
- Inteligencia Emocional ($15): Tatiana Arias.
- TECNOLOGÍA PARA PADRES ($15): Yadira Suárez.
- Contabilidad para no contadores (Próximamente - $20): E Arias.
- Docencia Virtual (Próximamente - $20): Tatiana Arias.
- Habilidades Cognitivas y Emocionales. Metodología Aprender a Pensar (Próximamente - $20): Tatiana Arias.`;
  }

  // Contacto / inscripción
  if (t.includes("contact") || t.includes("inscrib") || t.includes("inscripción") || t.includes("matric") || t.includes("registro")) {
    return `Contacto Fundación Capacítamente:
📱 0983222358
📧 info@fundacioncapacitamente.com
📍 Guayaquil - Ecuador`;
  }

  // Donación
  if (t.includes("don") || t.includes("donar") || t.includes("donación") || t.includes("donacion")) {
    return `Donaciones (paso a paso):
1) Entra a Donaciones y clic en "Donar ahora"
2) Elige cantidad o personalizada y clic en "Continuar"
3) Llena tus datos
4) Elige método (Transferencia o PayPal)
5) Clic en "Donar ahora"`;
  }

  // Cursos gratis
  if (t.includes("gratis") || t.includes("gratuito") || t.includes("gratuitos")) {
    return `Cursos Gratuitos:
- Tecnología para Educadores: Tatiana Arias.
- Metodología de la Pregunta (Próximamente): Tatiana Arias.
- Neuroeducación… También en casa (Próximamente): Prosandoval.`;
  }

  return null;
}

// Health (Render)
app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/chat', async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ reply: "Servidor sin API KEY. Configura GEMINI_API_KEY en Render." });
    }

    const userMessage = String(req.body?.message || '').trim();
    let sessionId = String(req.body?.sessionId || '').trim();

    if (!userMessage) {
      return res.status(400).json({ reply: "Mensaje no proporcionado." });
    }

    if (!sessionId) {
      sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    // ✅ 1) Primero intenta FAQ (cero consumo de IA)
    const quick = faqReply(userMessage);
    if (quick) {
      res.set('Cache-Control', 'no-store');
      return res.json({ reply: quick, sessionId });
    }

    // ✅ 2) Si no es FAQ, usa IA con sesión
    let session = sessions.get(sessionId);

    if (!session) {
      const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction,
          temperature: 0.3,
          maxOutputTokens: 350, // 🔥 menos tokens = menos costo/cuota
        },
      });

      session = { chat, lastAccess: Date.now() };
      sessions.set(sessionId, session);
      console.log("🆕 Nueva sesión:", sessionId);
    } else {
      session.lastAccess = Date.now();
    }

    const response = await session.chat.sendMessage({ message: userMessage });
    const reply = (typeof response.text === 'string') ? response.text.trim() : '';

    if (!reply) {
      console.warn("⚠️ Respuesta vacía del modelo. sessionId=", sessionId);
      return res.status(502).json({ reply: "La IA respondió vacío. Intenta nuevamente.", sessionId });
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ reply, sessionId });

  } catch (error) {
    const msg = String(error?.message || '');
    const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');

    if (is429) {
      return res.status(429).json({
        reply: "Estoy con alta demanda ahora mismo 😅. Intenta de nuevo en 1 minuto.",
      });
    }

    console.error("❌ Error /chat:", error);
    return res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde." });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
});

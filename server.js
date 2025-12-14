// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.set('trust proxy', 1); // importante en Render para IP real

const port = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en variables de entorno.");
}

const ai = new GoogleGenAI({ apiKey });

// ============================
// Config: límites y sesiones
// ============================
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_SESSIONS = 300;

const MAX_DAILY_AI_CALLS = Number(process.env.MAX_DAILY_AI_CALLS || 50);

// Contador diario (solo llamadas a IA)
let aiCallsToday = 0;
let aiCallsDayKey = getDayKeyEC();

function getDayKeyEC() {
  // Día en Ecuador (Guayaquil)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // YYYY-MM-DD
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

// Limpieza automática de sesiones
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

// System instruction
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

// Health
app.get('/health', (req, res) => res.status(200).send('ok'));

// FAQ sin IA (para ahorrar cuota)
function faqReply(message) {
  const t = message.toLowerCase();

  if (t.includes('donaci')) {
    return `Para donar:
1) Entra a Donaciones → "Donar ahora"
2) Elige una cantidad (o personalizada) → "Continuar"
3) Llena tus datos
4) Elige método (Transferencia o PayPal)
5) Presiona "Donar ahora"`;
  }

  if (t.includes('contact') || t.includes('inscrib') || t.includes('información') || t.includes('informacion')) {
    return `Contacto Fundación Capacítamente:
📱 0983222358
✉️ info@fundacioncapacitamente.com
📍 Guayaquil - Ecuador`;
  }

  if (t.includes('precio') || t.includes('costo') || (t.includes('curso') && (t.includes('pago') || t.includes('certif') || t.includes('certificado')))) {
    return `Cursos con certificado:
• Formador de Formadores ($120) – Tatiana Arias
• Inteligencia Emocional ($15) – Tatiana Arias
• Tecnología para Padres ($15) – Yadira Suárez

Próximamente:
• Contabilidad para no contadores ($20)
• Docencia Virtual ($20)
• Habilidades Cognitivas y Emocionales (Aprender a Pensar) ($20)`;
  }

  if (t.includes('gratis') || t.includes('gratuito')) {
    return `Cursos gratuitos:
• Tecnología para Educadores – Tatiana Arias
Próximamente:
• Metodología de la Pregunta – Tatiana Arias
• Neuroeducación… También en casa – Prosandoval`;
  }

  return null;
}

function extractStatus(err) {
  return (
    err?.status ||
    err?.code ||
    err?.error?.code ||
    err?.response?.status ||
    null
  );
}

function extractMessage(err) {
  if (typeof err?.message === 'string') return err.message;
  try {
    return JSON.stringify(err?.error || err);
  } catch {
    return String(err);
  }
}

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

    // 1) Intentar FAQ sin IA (no consume cuota)
    const faq = faqReply(userMessage);
    if (faq) {
      res.set('Cache-Control', 'no-store');
      return res.json({ reply: faq, sessionId });
    }

    // 2) Límite diario de llamadas a IA (50/día por defecto)
    if (!canUseAI()) {
      return res.status(429).json({
        reply: `Hoy ya se alcanzó el límite diario de respuestas con IA (${MAX_DAILY_AI_CALLS}/día). 
Puedes volver a intentar mañana o contactarnos por WhatsApp/Correo.`
      });
    }

    let session = sessions.get(sessionId);

    if (!session) {
      const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
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

    // Consumir 1 llamada a IA
    incAI();

    const response = await session.chat.sendMessage({ message: userMessage });
    const reply = (typeof response.text === 'string') ? response.text.trim() : '';

    if (!reply) {
      console.warn("⚠️ Respuesta vacía del modelo. sessionId=", sessionId);
      return res.status(502).json({ reply: "La IA respondió vacío. Intenta nuevamente.", sessionId });
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ reply, sessionId });

  } catch (error) {
    const status = extractStatus(error);
    const msg = extractMessage(error);

    console.error("❌ Error /chat:", msg);

    // Si Gemini te devuelve 429 (cuota / rate limit), responde 429 (no 500)
    if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(msg)) {
      res.set('Retry-After', '60');
      return res.status(429).json({
        reply: "Se alcanzó el límite de uso del servicio de IA por hoy. Intenta más tarde o mañana.",
      });
    }

    return res.status(500).json({
      reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde.",
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
});

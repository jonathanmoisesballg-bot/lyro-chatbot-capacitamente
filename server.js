// server.js (FINAL con @google/genai)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = process.env.PORT || 10000;

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("❌ Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en variables de entorno.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// Sesiones en memoria
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 300;

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

app.use(cors());
app.use(express.json({ strict: false, limit: '1mb' }));

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

app.post('/chat', async (req, res) => {
  try {
    const userMessage = String(req.body?.message || '').trim();
    let sessionId = String(req.body?.sessionId || '').trim();

    if (!userMessage) {
      return res.status(400).json({ reply: "Mensaje no proporcionado." });
    }

    if (!sessionId) {
      sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    let session = sessions.get(sessionId);

    if (!session) {
      const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction,
          temperature: 0.3,
          maxOutputTokens: 600
        }
      });

      session = { chat, lastAccess: Date.now() };
      sessions.set(sessionId, session);
      console.log("🆕 Nueva sesión:", sessionId);
    } else {
      session.lastAccess = Date.now();
    }

    const response = await session.chat.sendMessage({ message: userMessage });
    const reply = (typeof response?.text === 'string') ? response.text.trim() : '';

    if (!reply) {
      return res.status(502).json({ reply: "La IA respondió vacío. Intenta nuevamente.", sessionId });
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ reply, sessionId });

  } catch (error) {
    console.error("❌ Error /chat:", error);
    return res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde." });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
});

// server.js (VERSIÓN FINAL Y MÁS ROBUSTA PARA AMBIENTES LOCALES)

// 1. Cargar dependencias
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000; 

// Inicializar la API de Gemini 
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("Error: GEMINI_API_KEY no está configurada. Por favor, revisa tu archivo .env.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// ⚠️ ESTRUCTURA CLAVE: Caché en memoria para almacenar las sesiones de chat
const chatSessions = {}; 

// 2. MIDDLEWARE
app.use(cors()); 
// 💥 CORRECCIÓN DE PARSEO JSON: Usamos strict: false para mayor compatibilidad
app.use(express.json({ strict: false })); 

// 3. DEFINICIÓN: Base de Conocimiento (System Instruction)
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial. Tu objetivo es proporcionar información precisa, completa y concisa sobre la Fundación Capacítamente (https://fundacioncapacitamente.com/) y sus actividades, además de responder preguntas de conocimiento general.

Utiliza la siguiente información para las consultas sobre la Fundación:
- Misión Principal: Ofrecer capacitación de alto valor en habilidades blandas y digitales esenciales para el desarrollo profesional y empresarial.
- Cursos Principales: Ofrecemos una amplia variedad de cursos especializados en habilidades blandas y digitales.
- Cursos con Certificado (Costo e Instructor):
    - Formador de Formadores ($120): Impartido por Tatiana Arias.
    - Inteligencia Emocional ($15): Impartido por Tatiana Arias.
    - TECNOLOGÍA PARA PADRES ($15): Impartido por Yadira Suárez.
    - Contabilidad para no contadores (Próximamente - $20): Impartido por E Arias.
    - Docencia Virtual (Próximamente - $20): Impartido por Tatiana Arias.
    - Habilidades Cognitivas y Emocionales. Metodología Aprender a Pensar (Próximamente - $20): Impartido por Tatiana Arias.
- Cursos Gratuitos (Instructor):
    - Tecnología para Educadores: Impartido por Tatiana Arias.
    - Metodología de la Pregunta (Próximamente): Impartido por Tatiana Arias.
    - Neuroeducación… También en casa (Próximamente): Impartido por Prosandoval.
- Docentes: Tatiana Arias, Yadira Suárez, E Arias, Prosandoval.
- Contacto: 
    - Celular: 0983222358
    - Correo: info@fundacioncapacitamente.com
    - Ubicación: Guayaquil - Ecuador
- **Donaciones (Guía Paso a Paso):** 1. Ingresar a la sección de Donaciones en la web y haz clic en "Donar ahora". 
    2. Elegir Cantidad ($10, $25, etc.) o personalizada. Clic en "Continuar". 
    3. Llenar tus Datos (Nombre, Apellidos, Correo). 
    4. Elegir Método de Pago (Transferencia o PayPal). 
    5. Clic en "Donar ahora" para finalizar.

Si la pregunta no es sobre la Fundación, usa tu conocimiento general.
`;

// 4. ENDPOINT
app.post('/chat', async (req, res) => {
    try {
        // 💥 MÁXIMA COMPATIBILIDAD: Acceder directamente a req.body para evitar errores de desestructuración
        const userMessage = req.body.message;
        const sessionId = req.body.sessionId; 
        
        if (!userMessage || userMessage.trim().length === 0) {
            return res.status(400).json({ reply: "Mensaje no proporcionado." });
        }
        
        if (!sessionId) {
            return res.status(400).json({ reply: "Se requiere un sessionId para la conversación." });
        }
        
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: systemInstruction
        });
        
        let chat;
        
        // OBTENER O CREAR LA SESIÓN DE CHAT
        if (chatSessions[sessionId]) {
            chat = chatSessions[sessionId]; 
        } else {
            chat = model.startChat({ history: [] });
            chatSessions[sessionId] = chat;
            console.log(`Nueva sesión creada: ${sessionId}`); 
        }
        
        // CORRECCIÓN FINAL: Se envía userMessage directamente
        const result = await chat.sendMessage(userMessage); 
        const botReply = result.response.text;
        
        res.json({ reply: botReply, sessionId: sessionId }); 

    } catch (error) {
        console.error("Error al generar contenido:", error);
        res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde." });
    }
});

// 5. Iniciar el servidor 
app.listen(port, '0.0.0.0', () => { 
    console.log(`Servidor Node.js escuchando en el puerto ${port}`);
});
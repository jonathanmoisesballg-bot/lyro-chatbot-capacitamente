// server.js

// 1. Cargar dependencias y la clave API de .env
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const cors = require('cors');

const app = express();
const port = 3000; 

// Inicializar la API de Gemini (usa la clave del archivo .env)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 2. MIDDLEWARE: Permite que tu web acceda a este servidor
app.use(cors()); 
app.use(express.json()); 

// 3. DEFINICIÓN: Base de Conocimiento de la Fundación Capacítamente (FINAL, EFICIENTE Y COMPLETA)
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial. Tu objetivo es proporcionar información precisa, completa y concisa sobre la Fundación Capacítamente (https://fundacioncapacitamente.com/) y sus actividades, además de responder preguntas de conocimiento general.

Utiliza la siguiente información para las consultas sobre la Fundación:
- Misión Principal: Ofrecer capacitación de alto valor en habilidades blandas y digitales esenciales para el desarrollo profesional y empresarial.
- Cursos Principales: Ofrecemos una amplia variedad de cursos especializados en habilidades blandas y digitales. Consulta los detalles, costos e instructores a continuación.
- Cursos con Certificado (Costo e Instructor): Estos cursos tienen un costo y ofrecen un certificado de culminación:
    - Formador de Formadores ($120): Impartido por Tatiana Arias.
    - Inteligencia Emocional ($15): Impartido por Tatiana Arias.
    - TECNOLOGÍA PARA PADRES ($15): Impartido por Yadira Suárez.
    - Contabilidad para no contadores (Próximamente - $20): Impartido por E Arias.
    - Docencia Virtual (Próximamente - $20): Impartido por Tatiana Arias.
    - Habilidades Cognitivas y Emocionales. Metodología Aprender a Pensar (Próximamente - $20): Impartido por Tatiana Arias.
- Cursos Gratuitos (Instructor): Estos cursos se ofrecen sin costo:
    - Tecnología para Educadores: Impartido por Tatiana Arias.
    - Metodología de la Pregunta (Próximamente): Impartido por Tatiana Arias.
    - Neuroeducación… También en casa (Próximamente): Impartido por Prosandoval.
- Docentes: Los cursos son impartidos por profesionales expertos. Los instructores clave son Tatiana Arias, Yadira Suárez, E Arias y Prosendovel. Todos son expertos reconocidos en sus áreas.
- Donaciones: La Fundación acepta donaciones a través de su sitio web para apoyar sus programas de capacitación y crecimiento.
- Horarios: Todos los cursos se ofrecen en modalidad online y en vivo. Las sesiones están convenientemente programadas para las noches (martes y jueves).
- Contacto y Ubicación:
    - Celular: 0983222358
    - Teléfono fijo: 046026948
    - Correo electrónico para consultas e inscripción: info@fundacioncapacitamente.com y cursos@fundacioncapacitamente.com
    - Ubicación: Guayaquil - Ecuador
- Inscripción: Es un proceso simple: se completa el formulario en la web y se envía el comprobante de pago al correo de inscripción.

Tu respuesta debe ser siempre amable, profesional y motivadora. Si la pregunta no es sobre la Fundación, utiliza tu conocimiento general para responder de forma útil y eficiente, manteniendo tu personalidad de asistente.
`;

// 4. ENDPOINT: La ruta de la API que recibe la pregunta
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        // Validación robusta para evitar errores con mensajes vacíos o muy cortos
        if (!userMessage || userMessage.trim().length === 0) {
            return res.status(400).json({ error: "Mensaje no proporcionado." });
        }

        // Llamada a la API de Gemini con el contexto de la fundación
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: userMessage,
            config: {
                systemInstruction: systemInstruction, 
            }
        });

        const botReply = response.text.trim();
        res.json({ reply: botReply }); 

    } catch (error) {
        console.error("Error al generar contenido:", error);
        // Respuesta de error amigable, aunque el servidor siga en pie
        res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde." });
    }
});

// 5. Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor de Chatbot iniciado en http://localhost:${port}`);
});
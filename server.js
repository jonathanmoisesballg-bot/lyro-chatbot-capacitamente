// server.js

// 1. Cargar dependencias
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const cors = require('cors');

const app = express();
// Puerto 10000 para Render, o usa el puerto por defecto (3000) si no se especifica.
const port = process.env.PORT || 10000; 

// Inicializar la API de Gemini 
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("Error: GEMINI_API_KEY no está configurada.");
    // Detener la ejecución si no hay clave API
    process.exit(1); 
}

const genAI = new GoogleGenerativeAI(apiKey);

// 2. MIDDLEWARE
app.use(cors()); 
app.use(express.json()); 

// 3. DEFINICIÓN: Base de Conocimiento y Modelo (Inicializado una sola vez)
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

// CORRECCIÓN Y OPTIMIZACIÓN: Inicializamos el modelo solo una vez.
// Esto es más eficiente que hacerlo en cada solicitud.
const model = genAI.getGenerativeModel({ 
    // CORRECCIÓN CRÍTICA: Usamos el nombre de modelo actual.
    model: "gemini-2.5-flash", 
    systemInstruction: systemInstruction
});


// 4. ENDPOINT
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        if (!userMessage || userMessage.trim().length === 0) {
            return res.status(400).json({ reply: "Mensaje no proporcionado." });
        }
        
        // 🚨 CAMBIO: Usamos generateContent directamente en el modelo preconfigurado
        // Esto es ideal para una interacción pregunta/respuesta sin historial.
        const result = await model.generateContent(userMessage);
        
        const botReply = result.text;
        
        res.json({ reply: botReply });

    } catch (error) {
        console.error("Error al generar contenido:", error);
        res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde." });
    }
});

// 5. Iniciar el servidor (Bind 0.0.0.0 para Render)
app.listen(port, '0.0.0.0', () => { 
    console.log(`Servidor Node.js escuchando en el puerto ${port}`);
});
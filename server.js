// server.js

// 1. Cargar dependencias y la clave API de .env
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000; 

// Inicializar la API de Gemini 
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("Error: GEMINI_API_KEY no está configurada. Verifica las Variables de Entorno de Render.");
}
const ai = new GoogleGenAI({ apiKey: apiKey }); 

// 2. MIDDLEWARE
app.use(cors()); 
app.use(express.json()); 

// 3. DEFINICIÓN: Base de Conocimiento de la Fundación Capacítamente (FINAL, EFICIENTE Y COMPLETA)
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial. Tu objetivo es proporcionar información precisa, completa y concisa sobre la Fundación Capacítamente (https://fundacioncapacitamente.com/) y sus actividades, además de responder preguntas de conocimiento general.

Utiliza la siguiente información para las consultas sobre la Fundación:
- Misión Principal: Ofrecer capacitación de alto valor en habilidades blandas y digitales esenciales para el desarrollo profesional y empresarial.
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
- Contacto y Ubicación:
    - Celular: 0983222358
    - Teléfono fijo: 046026948
    - Correo electrónico para consultas e inscripción: info@fundacioncapacitamente.com y cursos@fundacioncapacitamente.com
    - Ubicación: Guayaquil - Ecuador
- Inscripción: Es un proceso simple: se completa el formulario en la web y se envía el comprobante de pago al correo de inscripción.
- **Donaciones (Guía Paso a Paso):** La Fundación acepta donaciones para apoyar su causa. El proceso es online: 1. Ingresar a la sección de Donaciones y haz clic en el botón "Donar ahora". 2. Elegir Cantidad: Selecciona un monto (ej. $10, $25, $100, etc.) o ingresa una "Cantidad personalizada". Luego presiona "Continuar". 3. Tus Datos: Llena el formulario con tu Nombre, Apellidos y Dirección de correo electrónico. 4. Método de Pago: Elige entre "Donar con Transferencia Bancaria" o "Donar con PayPal". 5. Finalizar: Haz clic en el botón verde "Donar ahora" para completar el proceso de forma segura.

Tu respuesta debe ser siempre amable, profesional y motivadora. Si la pregunta no es sobre la Fundación, utiliza tu conocimiento general para responder de forma útil y eficiente, manteniendo tu personalidad de asistente.
`;

// 4. ENDPOINT
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        if (!userMessage || userMessage.trim().length === 0) {
            return res.status(400).json({ reply: "Mensaje no proporcionado." });
        }
        
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.5-flash',
            config: {
                 systemInstruction: systemInstruction,
            }
        });
        
        const chat = model.startChat({});
        
        const result = await chat.sendMessage({ message: userMessage });
        const botReply = result.text;
        
        res.json({ reply: botReply });

    } catch (error) {
        console.error("Error al generar contenido:", error);
        res.status(500).json({ reply: "Lo siento, hubo un error interno. Intenta de nuevo más tarde." });
    }
});

// 5. Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor Node.js escuchando en el puerto ${port}`);
});
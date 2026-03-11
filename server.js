// server.js
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
// Contacto (centralizado)
// ============================
const CONTACT_PHONE_1 = process.env.CONTACT_PHONE_1 || "0983222358";
const CONTACT_PHONE_2 = process.env.CONTACT_PHONE_2 || "046026948";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "cursos@fundacioncapacitamente.com";
const CONTACT_CITY = process.env.CONTACT_CITY || "Guayaquil - Ecuador";
const PRESENTIAL_SEDE = process.env.PRESENTIAL_SEDE || "Guayaquil";
const WHATSAPP_COUNTRY_CODE = process.env.WHATSAPP_COUNTRY_CODE || "593";
const CONTACT_WHATSAPP = process.env.CONTACT_WHATSAPP || CONTACT_PHONE_1;

// ============================
// Seguridad / límites simples
// ============================
const MAX_MESSAGE_CHARS = Math.max(100, Number(process.env.MAX_MESSAGE_CHARS || 1200));

// Rate limit (opcional, sin librerías)
const RATE_LIMIT_MAX = Math.max(0, Number(process.env.RATE_LIMIT_MAX || 60)); // req por ventana
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000));
const rateBuckets = new Map();

function rateKey(req) {
  // usa clientId si existe, si no IP|UA (como tu userKey)
  return getUserKey(req);
}

function checkRateLimit(req) {
  if (RATE_LIMIT_MAX <= 0) return { ok: true };

  const key = rateKey(req);
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };

  if (now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - bucket.start);
    return { ok: false, retryAfterMs };
  }

  return { ok: true };
}

// Headers básicos
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// ============================
// CORS (IMPORTANTE: x-client-id)
// ============================
// Si quieres restringir: CORS_ORIGIN=https://tudominio.com (o lista separada por coma)
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "*").trim();
const corsOptions = {
  origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-client-id"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ strict: false, limit: "1mb" }));

// ============================
// IA (Gemini) - SOLO se usa si NO es tema Fundación
// ============================
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.warn("⚠️ Falta GEMINI_API_KEY (o GOOGLE_API_KEY). El bot funcionará en modo Fundación/FAQ sin IA.");
}
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Variables que YA tienes en Render (las usamos)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE || 0.3);
const GEMINI_MAX_TOKENS = Number(process.env.GEMINI_MAX_TOKENS || 600);
const AI_COOLDOWN_MS = Number(process.env.AI_COOLDOWN_MS || 0);

// Reintentos contra "modelo ocupado"
const GEMINI_RETRIES = Math.max(0, Number(process.env.GEMINI_RETRIES || 2));
const GEMINI_RETRY_BASE_MS = Math.max(100, Number(process.env.GEMINI_RETRY_BASE_MS || 700));

// ============================
// Supabase
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log("✅ Supabase configurada: verdadero");
} else {
  console.warn("⚠️ Supabase NO configurada. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
}

// ============================
// System instruction (IA)
// ============================
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial.
Responde de forma clara, completa y concisa. Si algo es ambiguo, pide un dato puntual.
`;

// ============================
// Helpers base
// ============================
function normalizeText(s) {
  // ✅ Importante: permite el signo "+" para que "5+" no se vuelva "5"
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s\-+]/g, "") // ✅ permite "+"
    .replace(/\s+/g, " ")
    .trim();
}

function formatWhatsAppNumber(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0") && digits.length >= 9) {
    digits = `${WHATSAPP_COUNTRY_CODE}${digits.slice(1)}`;
  }
  return digits;
}

function getWhatsAppLink() {
  const digits = formatWhatsAppNumber(CONTACT_WHATSAPP);
  return digits ? `https://wa.me/${digits}` : "";
}

function clampMessage(s) {
  const msg = String(s || "").trim();
  if (msg.length <= MAX_MESSAGE_CHARS) return msg;
  return msg.slice(0, MAX_MESSAGE_CHARS);
}

function getClientId(req) {
  const h = String(req.headers["x-client-id"] || "").trim();
  const b = String(req.body?.clientId || "").trim();
  const q = String(req.query?.clientId || "").trim();
  return (h || b || q || "").slice(0, 120);
}

function getUserKey(req) {
  const clientId = getClientId(req);
  if (clientId) return `cid:${clientId}`.slice(0, 500);

  const ip = req.ip || "";
  const ua = req.headers["user-agent"] || "";
  return `${ip} | ${ua}`.slice(0, 500);
}

function newSessionId() {
  return `session-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function extractStatus(err) {
  return err?.status || err?.code || err?.error?.code || err?.response?.status || null;
}

function extractMessage(err) {
  if (typeof err?.message === "string") return err.message;
  try {
    return JSON.stringify(err?.error || err);
  } catch {
    return String(err);
  }
}

function sendJson(res, payload, status = 200) {
  res.set("Cache-Control", "no-store");
  return res.status(status).json(payload);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableGeminiError(status, msg) {
  const m = String(msg || "");
  if (status === 503) return true;
  if (status === 429) return true;
  if (/overloaded|temporarily|unavailable|try again|timeout/i.test(m)) return true;
  if (/NO DISPONIBLE/i.test(m)) return true;
  return false;
}

// ✅ Fallback neutro (NUNCA dice “IA no pudo responder”)
function aiFallbackMenuText() {
  return `En este momento no puedo responder esa consulta.

📌 Puedes:
1) Escribir: MENU (para ver opciones)
2) Elegir una opción del menú (1-6)
3) O contactarnos:
📱 ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}`;
}

// ============================
// Cursos (INFO + INSCRIPCIÓN)
// ============================
// NOTA:
// - Para el MENÚ (1 y 2) se listan TODOS (incluye Próx.) en orden A-Z.
// - Para INSCRIBIRME solo se muestran los DISPONIBLES (available: true).

const FREE_COURSES = [
  {
    name: "Tecnología para Educadores",
    label: "🎓 Tecnología para Educadores – Tatiana Arias (Gratis)",
    available: true,
  },
  {
    name: "Metodología de la Pregunta",
    label: "🎓 Metodología de la Pregunta – Tatiana Arias (Próx.)",
    available: false,
  },
  {
    name: "Neuroeducación… También en casa",
    label: "🎓 Neuroeducación… También en casa – Prosandoval (Próx.)",
    available: false,
  },
];

const CERT_COURSES = [
  {
    name: "Formador de Formadores",
    label: "🎓 Formador de Formadores ($120) – Tatiana Arias",
    available: true,
  },
  {
    name: "Inteligencia Emocional",
    label: "🎓 Inteligencia Emocional ($15) – Tatiana Arias",
    available: true,
  },
  {
    name: "Tecnología para Padres",
    label: "🎓 Tecnología para Padres ($15) – Yadira Suárez",
    available: true,
  },

  // Próximamente
  {
    name: "Contabilidad para no contadores",
    label: "🎓 Contabilidad para no contadores ($20) (Próx.)",
    available: false,
  },
  {
    name: "Docencia Virtual",
    label: "🎓 Docencia Virtual ($20) (Próx.)",
    available: false,
  },
  {
    name: "Habilidades Cognitivas y Emocionales (Aprender a Pensar)",
    label: "🎓 Habilidades Cognitivas y Emocionales (Aprender a Pensar) ($20) (Próx.)",
    available: false,
  },
];

// ============================
// Enumeración alfabética A,B,C...
// ============================
const ALPHA = "abcdefghijklmnopqrstuvwxyz".split("");

function alphaKey(i) {
  return ALPHA[i] || String(i + 1);
}

function alphaLabel(i) {
  return alphaKey(i).toUpperCase();
}

function sortCoursesByName(list) {
  return [...list].sort((a, b) => normalizeText(a.name).localeCompare(normalizeText(b.name)));
}

// Detecta si el usuario escribió "A", "a)", "a." etc.
function extractAlphaChoice(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/^([a-zA-Z])(?:[\)\.\-:\s]|$)/);
  return m ? m[1].toLowerCase() : "";
}

// Construye opciones: texto enumerado + botones enumerados + mapa letra->curso
function buildCoursePicker(type, { availableOnly } = { availableOnly: true }) {
  const base =
    type === "free"
      ? FREE_COURSES
      : type === "cert"
      ? CERT_COURSES
      : [...FREE_COURSES, ...CERT_COURSES];

  const list = sortCoursesByName(availableOnly ? base.filter((c) => c.available) : base);

  const map = {}; // { a: "Tecnología para Educadores", b: "..." }
  const lines = []; // ["A) ...", "B) ..."]
  const suggestions = []; // [{text:"a", label:"A) ..."}]

  list.forEach((c, idx) => {
    const k = alphaKey(idx);
    const L = alphaLabel(idx);

    map[k] = c.name;

    lines.push(`${L}) ${c.label}`);
    suggestions.push({ text: k, label: `${L}) ${c.label}` });
  });

  suggestions.push({ text: "menu", label: "📌 Menu" });
  suggestions.push({ text: "cancelar", label: "✖ Cancelar" });

  return { list, map, lines, suggestions };
}

// ============================
// Textos Fundación (SIN IA)
// ============================
function menuOpcionesTexto() {
  return `👋 Hola, soy LYRO-CAPACÍTAMENTE 🤖

📌 ESTÁS EN EL MENÚ PRINCIPAL (elige una opción)

1) Cursos gratis
2) Cursos con certificados y precios
3) Contacto
4) Donar
5) Estado de certificado
6) Horarios

Responde con el número (1-6) o escribe tu pregunta.`;
}

// ✅ (A-Z) para menú opción 1
function cursosGratisTexto() {
  const pick = buildCoursePicker("free", { availableOnly: false });

  return `🎓 CURSOS GRATUITOS (A-Z)

${pick.lines.join("\n")}

Si quieres recomendación personalizada, Escribe: TEST DE AYUDA 
Si quieres inscribirte hay dos opciones, escribe: INSCRIBIRME . 
La otra opción es inscribirte mediante la página web creando tu cuenta.
Escribe: CREAR CUENTA o REGISTRARME para ver los pasos.`;
}

// ✅ (A-Z) para menú opción 2
function cursosCertTexto() {
  const pick = buildCoursePicker("cert", { availableOnly: false });

  return `🎓 CURSOS CON CERTIFICADO (A-Z)

${pick.lines.join("\n")}

Si quieres recomendación personalizada, Escribe: TEST DE AYUDA 
Si quieres inscribirte hay dos opciones, escribe: INSCRIBIRME . 
La otra opción es inscribirte mediante la página web creando tu cuenta.
Escribe: CREAR CUENTA o REGISTRARME para ver los pasos.`;
}

function todosLosCursosTexto() {
  const free = buildCoursePicker("free", { availableOnly: false });
  const cert = buildCoursePicker("cert", { availableOnly: false });
  const freeBullets = free.list.map((c) => `● ${c.label}`).join("\n");
  const certBullets = cert.list.map((c) => `● ${c.label}`).join("\n");

  return `📚 TODOS LOS CURSOS

🎓 CURSOS GRATUITOS:
${freeBullets}

🎓 CURSOS CON CERTIFICADO:
${certBullets}`;
}

// ✅ NUEVO: pagos
function pagosTexto() {
  return `💳 PAGOS DE CURSOS (Solo cursos con certificado)

Los pagos son por Transferencia bancaria directa o PayPhone.

📌 Para pagar, primero debes inscribirte a un curso (solo los de certificados).

✅ Para inscribirte tienes 2 opciones:
• Escribe: INSCRIBIRME (aquí mismo) y elige el curso.
• O puedes inscribirte por la página web creando tu cuenta y siguiendo el proceso de inscripción.
  Si necesitas la guía, escribe: CREAR CUENTA o REGISTRARME.

Al final, parte del equipo de la Fundación se contactará contigo.`;
}


function contactoTexto() {
  return `📞 CONTACTO FUNDACIÓN CAPACÍTAMENTE

📱 ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}
📍 ${CONTACT_CITY}`;
}

function whatsappInfoTexto() {
  return `📱 CONTACTO OFICIAL POR WHATSAPP

Con gusto te atendemos por este medio.

Número de WhatsApp:
✅ ${CONTACT_PHONE_1}

También puedes abrir el chat directo tocando el ícono de WhatsApp que aparece junto al botón de nuestro chatbot en la página.

Si lo prefieres, también puedes escribirnos a:
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}`;
}

function buildGuidedFallbackForFoundation(text) {
  const s = normalizeText(text);

  const looksFoundationLike =
    s.includes("fundacion") ||
    s.includes("capacitamente") ||
    s.includes("curso") ||
    s.includes("beca") ||
    s.includes("certific") ||
    s.includes("inscrib") ||
    s.includes("cuenta") ||
    s.includes("setec") ||
    s.includes("contact") ||
    s.includes("whatsapp") ||
    s.includes("horario") ||
    s.includes("testimonio") ||
    s.includes("fundadora");

  if (!looksFoundationLike) return null;

  return {
    reply: `Puedo ayudarte mejor si eliges una ruta directa:

- 1 (Cursos gratis)
- 2 (Cursos con certificados y precios)
- BECAS
- REQUISITOS DE APROBACION
- CREAR CUENTA
- CONTACTO

Si prefieres, escribe MENU para ver todas las opciones.`,
    suggestions: [
      { text: "1", label: "1) Cursos gratis" },
      { text: "2", label: "2) Cursos con certificados y precios" },
      { text: "becas", label: "🎓 Becas" },
      { text: "requisitos de aprobacion", label: "✅ Requisitos de aprobación" },
      { text: "crear cuenta", label: "🔐 Crear cuenta" },
      { text: "3", label: "📞 Contacto" },
      { text: "menu", label: "📌 Menu" },
    ],
  };
}

function donarTexto() {
  return `💙 DONAR (pasos)

1) Entra a Donaciones → "Donar ahora"
2) Elige una cantidad (o personalizada) → "Continuar"
3) Llena tus datos
4) Elige método (Transferencia o PayPal)
5) Presiona "Donar ahora"`;
}

function horariosTexto() {
  return `🕒 HORARIOS (presencial o virtual)

Los horarios pueden ser presenciales o virtuales. Son FLEXIBLES y se ajustan a tu disponibilidad.
Si lo necesitas, puedes proponer tu propio horario.

📌 Primero, dime la modalidad que prefieres:
- Presencial
- Virtual`;
}

function horariosConsultaTexto() {
  return `🕒 HORARIO DE CLASES

Los horarios se organizan de acuerdo con la preferencia que registraste (manana, tarde o noche).
Con base en ese horario, parte del equipo de la Fundacion se contactara contigo para confirmar el dia y la hora exactos de tus clases.

Si aun no registraste tu horario, puedes hacerlo en la opcion:
6) Horarios`;
}

function inicioClasesTexto() {
  return `📌 INFORMACION SOBRE INICIO DE CLASES

Una vez inscrito/a, parte del equipo de la Fundacion se contactara contigo para confirmar el pago y habilitar tu acceso al curso seleccionado.

✅ Despues de esa confirmacion, recibiras las indicaciones para el inicio de clases.`;
}

function beneficiosTexto() {
  return `✅ BENEFICIOS EN FUNDACIÓN CAPACÍTAMENTE

- Formación online accesible y de excelencia.
- Metodología innovadora basada en: tecnología, constructivismo, neurociencia e inteligencia emocional.
- Enfoque social: orientado especialmente a población vulnerable, con compromiso en progreso social, económico y en valores.
- Cursos gratuitos y cursos con certificación a bajo costo.
- Modalidad virtual y flexible.
- Acompañamiento y asesoría para elegir el curso ideal.`;
}

function becasTexto() {
  return `🎓 BECAS FUNDACION CAPACITAMENTE

Si ofrecemos becas parciales segun evaluacion del caso.

Pasos para solicitarla:
1) Elige el curso que te interesa.
2) Envia tu solicitud de beca al correo: ${CONTACT_EMAIL}
3) Incluye: nombres completos, WhatsApp, curso, motivo de la solicitud y situacion actual.

⏱️ Tiempo de respuesta referencial: hasta 3 dias laborables.

Si deseas, primero te ayudo a elegir curso. Escribe: TEST DE AYUDA.`;
}

function historialTexto() {
  return `Para revisar tu historial de conversaciones, usa el panel lateral derecho.

Paso a paso:
1) En la parte superior derecha del chat, pulsa el botón con las tres líneas (☰).
2) Se abrirá el panel de Historial, donde podrás ver tus conversaciones.

Por seguridad y orden, el historial solo se puede consultar desde ese panel.

Si deseas volver al menú principal, escribe: MENU.`;
}

function cursosFuturosTexto() {
  return `📚 PROPUESTA DE CURSOS A IMPLEMENTAR

Con base en el enfoque formativo de la Fundacion, estas son recomendaciones de cursos que pueden aportar alto impacto academico y social:

• Alfabetizacion Digital para Adultos y Emprendedores
• IA Practica para Docentes (sin programacion)
• Manejo de Estres y Regulacion Emocional para Familias
• Neuroaprendizaje para Memoria y Atencion
• Habilidades Blandas para Primer Empleo
• Finanzas Personales y Economia Familiar
• Emprendimiento Digital con Canva, WhatsApp e Instagram
• Herramientas de Google para Estudio y Trabajo
• Comunicacion Asertiva y Resolucion de Conflictos
• Ciberseguridad y Prevencion de Riesgos Digitales`;
}

function diferenciaCursosTexto() {
  return `📚 DIFERENCIA: CURSO GRATUITO VS CURSO CON CERTIFICADO

1) Curso gratuito:
- Acceso al contenido formativo sin costo.
- Puede incluir constancia interna segun disponibilidad del programa.

2) Curso con certificado:
- Requiere pago.
- Incluye certificacion al cumplir los requisitos academicos del curso.

✅ Para ver cursos:
- Escribe 1 (gratis)
- Escribe 2 (con certificado y precios)`;
}

function setecTexto() {
  return `🧾 QUE ES SETEC

SETEC es el organismo de referencia en procesos de capacitacion y certificacion por competencias en Ecuador.

En los cursos que aplican, la evaluacion/certificacion puede seguir lineamientos asociados a SETEC.

Si deseas saber si un curso puntual aplica para ese esquema, dime el nombre del curso y te orientamos.`;
}

function aprobacionCursosTexto() {
  return `✅ REQUISITOS DE APROBACION

- Cursos gratuitos: referencia minima de 70% de cumplimiento academico.
- Cursos con certificado: pueden incluir evaluacion final y criterios adicionales segun el programa.
- En programas vinculados a estandar externo, se aplican los requisitos definidos para ese curso.

Si deseas, te explico los requisitos exactos de un curso puntual.`;
}

function recursosCursoTexto() {
  return `🧰 RECURSOS DE APRENDIZAJE

Dependiendo del curso, puedes recibir:
- Videos
- Guias o material PDF
- Actividades practicas
- Acompanamiento academico

Algunos cursos tambien incluyen recursos complementarios segun su malla.`;
}

function modalidadesTexto() {
  return `🌐 MODALIDADES DISPONIBLES

La Fundacion maneja modalidad Online y, en programas seleccionados, modalidad Presencial.

- Online: horarios flexibles y acceso remoto.
- Presencial: se habilita por convocatoria/programa.

Si deseas iniciar tu inscripcion ahora, escribe: INSCRIBIRME.`;
}

function empresasTexto() {
  return `🏢 CAPACITACION PARA INSTITUCIONES

Contamos con opciones para instituciones y grupos.

✅ Para grupos desde 10 personas:
- Podemos revisar descuentos y propuesta adaptada.

Para coordinar una propuesta, comparte:
1) Nombre de la institucion
2) Cantidad de participantes
3) Curso de interes
4) Modalidad (online/presencial)`;
}

function instructorTexto() {
  return `🧑‍🏫 FORMAR PARTE DE LA FUNDACION (INSTRUCTOR/A, MAESTRO/A O DOCENTE)

Si deseas ser parte del equipo de la Fundacion:
1) Envia tu hoja de vida al correo: cursos@fundacioncapacitamente.com
2) Indica tu area de especialidad y experiencia
3) Comparte tu WhatsApp de contacto

Contactos oficiales:
📱 0983222358
☎️ 046026948
✉️ cursos@fundacioncapacitamente.com
📍 Guayaquil - Ecuador

El equipo academico revisara tu perfil y se contactara contigo.`;
}

function tiendaSolidariaTexto() {
  return `🛍️ TIENDA SOLIDARIA

En la Tienda Solidaria puedes encontrar productos educativos y materiales de apoyo de la Fundacion.

Para ingresar:
1) Abre el menu principal del sitio
2) Entra a: Tienda Solidaria
3) Si deseas comprar o gestionar pedidos, usa Mi Cuenta

Si necesitas apoyo para crear tu cuenta, escribe: CREAR CUENTA.`;
}

function fundadoraTexto() {
  return `👩‍💼 FUNDADORA DE LA FUNDACION

La Ing. Tatiana Arias es:
- Magister en Investigacion Educativa y Docencia.
- Lider Social Latinoamericana.
- Especializacion en Espana.
- Coordinadora Academica Metodologica.
- Docente de la Universidad de Guayaquil.

La Fundacion Capacitamente nace hace mas de 10 anos como expresion de su compromiso social.

Si deseas ver el menu principal, escribe: MENU.`;
}

function testimoniosTexto() {
  return `💬 TESTIMONIOS SOBRE LA FUNDACION

[[TESTIMONIOS_CARDS]]
Monica Valencia|Docente de Basica Superior|Ha sido una experiencia increible y maravillosa; el equipo en su totalidad denoto su gran capacidad de ensenanza.
Alexandra Manzo|Docente de Basica Media|Gracias a la Fundacion Capacitamente he descubierto un mundo apasionante de aprendizaje y autoconocimiento.
Fabio Cereceda|Maestro de Matematicas|Experiencia inolvidable para aprender nuevas tecnicas que me acompanaran en mi superacion profesional.
[[/TESTIMONIOS_CARDS]]

Si deseas ver el menu principal, escribe: MENU.`;
}

function sugerenciaCursoTexto() {
  return `🎯 ORIENTACION DE CURSO RECOMENDADO

Con gusto te ayudamos a elegir el curso ideal segun tu perfil, objetivos y disponibilidad.

✅ Para una recomendacion precisa y personalizada:
Escribe: TEST DE AYUDA

El test es breve y, al finalizar, te sugeriremos la mejor opcion para ti.`;
}

function recuperarContrasenaTexto() {
  return `🔐 RECUPERAR CONTRASEÑA DE TU CUENTA (FUNDACIÓN)

Sigue estos pasos:

1) Ingresa a la pantalla de inicio de sesión de tu cuenta.
2) Haz clic en: "¿Olvidaste tu contraseña?".
3) Escribe tu correo electrónico registrado.
4) Revisa tu correo y abre el enlace de recuperación.
5) Crea tu nueva contraseña y guárdala.
6) Vuelve a iniciar sesión con tu nueva contraseña.

📌 Si no ves el correo, revisa SPAM o correo no deseado.

Si todavía no puedes ingresar, contáctanos:
📱 ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}`;
}

function crearCuentaTexto() {
  return `🔐 PARA CREARTE UNA CUENTA O REGISTRARTE (FUNDACIÓN)

Sigue estos pasos:

1) Selecciona, en la parte superior, donde dice: Tienda solidaria / Mi cuenta.
2) Verás dos paneles. Completa el de Registrarte e ingresa:
   - Nombre de usuario (puede ser tu nombre y apellido)
   - Correo electrónico
   - Contraseña
3) Revisa tu correo y abre el enlace de autenticación para validar tu cuenta.

📌 Si no ves el correo, revisa SPAM o correo no deseado.

Si todavía no puedes registrarte, contáctanos:
📱 ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}`;
}

function misionTexto() {
  return `🎯 NUESTRA MISIÓN

Brindar una formación online de excelencia y accesible, con una metodología innovadora basada en el uso de estrategias tecnológicas, constructivismo, neurociencia e inteligencia emocional, con el objetivo de responder a las necesidades del campo laboral actual, orientada sobre todo a la población más vulnerable, comprometida con el progreso social, económico y en valores de la sociedad.`;
}

function visionTexto() {
  return `🌟 NUESTRA VISIÓN

Ser reconocida nacional e internacionalmente como un referente de educación con enfoque social, dirigida para todo aquel que desee adquirir conocimientos significativos.

- Implementar las mejores e innovadoras estrategias pedagógicas y tecnológicas en sus cursos para lograr mayor integración laboral.
- Consolidarse como el mejor centro de capacitación online y presencial del Ecuador y Latinoamérica.
- Transferir metodologías constructivistas, inteligencia emocional y neurociencia a nivel nacional e internacional.`;
}

function valoresTexto() {
  return `🧭 VALORES

- Disciplina
- Compromiso social
- Liderazgo
- Aprendizaje continuo
- Integridad
- Inclusión
- Empatía`;
}

function pilaresTexto() {
  return `🏛️ NUESTRA DIFERENCIA: PILARES FUNDAMENTALES

Contamos con 4 pilares sobre los cuales se soportan nuestros cursos:
- Tecnología
- Constructivismo
- Inteligencia Emocional
- Neurociencia`;
}

function quienesSomosTexto() {
  return `👥 ¿QUIÉNES SOMOS?

La Fundación Capacítamente nace hace más de 10 años como expresión del compromiso social de su fundadora. En 2021 nace la Fundación Capacítamente “Formando Mentes y Corazones” como Centro de Formación Profesional y Asesorías, para el Trabajo y el Desarrollo Humano, especializada en capacitación en educación, tecnología, inteligencia emocional, neurociencia y más.

Uno de nuestros objetivos es ayudar a las personas a alcanzar sus metas por medio de una educación de alta calidad y al alcance de todos.`;
}

function trabajarConNosotrosTexto() {
  return `🤝 TRABAJA / COLABORA CON NOSOTROS

Para colaborar, ser voluntario/a, proponer alianzas o participar como facilitador/a, contáctanos:

📱 WhatsApp: ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}
📍 ${CONTACT_CITY}`;
}

// Certificarme (sin IA) -> lista
function certificarmeIntroTexto() {
  const lines = CERT_COURSES.map((c) => `- ${c.label}`).join("\n");
  return `📜 CERTIFICACION

Para certificarte, elige el CURSO:

${lines}

(Escribe el nombre del curso tal cual o tocalo en los botones)`;
}

function suggestionsMenu() {
  return [
    { text: "1", label: "1) Cursos gratis" },
    { text: "2", label: "2) Cursos con certificados y precios" },
    { text: "3", label: "3) Contacto" },
    { text: "4", label: "4) Donar" },
    { text: "5", label: "5) Estado de certificado" },
    { text: "6", label: "6) Horarios" },
  ];
}

function suggestionsOnlyMenu() {
  return [{ text: "menu", label: "📌 Menu" }];
}

function suggestionsBecas() {
  return [
    { text: "test de ayuda", label: "🧭 Test de ayuda" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsAfterScholarshipTest() {
  return [{ text: "menu", label: "📌 Menu" }];
}

function suggestionsDifference() {
  return [
    { text: "1", label: "1) Cursos gratis" },
    { text: "2", label: "2) Cursos con certificados y precios" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsStore() {
  return [
    { text: "crear cuenta", label: "🔐 Crear cuenta" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsCourseLists() {
  return [
    { text: "menu", label: "📌 Menu" },
    { text: "test de ayuda", label: "🧭 Test de ayuda" },
    { text: "inscribirme", label: "📝 Inscribirme" },
  ];
}

function suggestionsAfterInfo() {
  return [
    { text: "menu", label: "📌 Menu" },
    { text: "test de ayuda", label: "🧪 Test de ayuda" },
    { text: "inscribirme", label: "📝 Inscribirme" },
    { text: "certificarme", label: "📜 Certificarme" },
    { text: "trabaja con nosotros", label: "🤝 Trabaja con nosotros" },
    { text: "3", label: "📞 Contacto" },
  ];
}

function suggestionsFundacionInfo() {
  return [
    { text: "menu", label: "📌 Menu" },
    { text: "quienes somos", label: "👥 ¿Quiénes somos?" },
    { text: "fundadora", label: "👩‍💼 Fundadora" },
    { text: "becas", label: "🎓 Becas" },
    { text: "setec", label: "🧾 SETEC" },
    { text: "mision", label: "🎯 Misión" },
    { text: "vision", label: "🌟 Visión" },
    { text: "valores", label: "🧭 Valores" },
    { text: "pilares", label: "🏛️ Pilares" },
    { text: "testimonios", label: "💬 Testimonios" },
    { text: "tienda solidaria", label: "🛍️ Tienda solidaria" },
    { text: "certificarme", label: "📜 Certificarme" },
    { text: "trabaja con nosotros", label: "🤝 Trabaja con nosotros" },
  ];
}

function suggestionsCertFlow() {
  return [
    { text: "menu", label: "📌 Menu" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
}

function suggestionsScheduleFlowStep1() {
  return [
    { text: "mañana", label: "🌤️ Mañana" },
    { text: "tarde", label: "🌇 Tarde" },
    { text: "noche", label: "🌙 Noche" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsScheduleFlowMode() {
  return [
    { text: "presencial", label: "🏫 Presencial" },
    { text: "virtual", label: "💻 Virtual" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsScheduleFlowStep2() {
  return [
    { text: "lun-vie", label: "📅 Lun-Vie" },
    { text: "sabado y domingo", label: "📅 Sábado y Domingo" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsHorariosMenu() {
  return [
    { text: "6", label: "6) Horarios" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsAfterScheduleSaved() {
  return [
    { text: "inscribirme", label: "📝 Inscribirme" },
    { text: "test de ayuda", label: "🧪 Test de ayuda" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsAdvisorStart() {
  return [
    { text: "docente", label: "👩‍🏫 Docente" },
    { text: "padre", label: "👨‍👩‍👧 Padre/Madre" },
    { text: "estudiante", label: "🎒 Estudiante" },
    { text: "profesional", label: "💼 Profesional" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsAdvisorInterest() {
  return [
    { text: "habilidades blandas", label: "🧠 Habilidades blandas" },
    { text: "tecnologia", label: "💻 Tecnología" },
    { text: "educacion", label: "📚 Educación" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsAdvisorTime() {
  return [
    { text: "1-2", label: "⏱️ 1-2h/semana" },
    { text: "3-5", label: "⏱️ 3-5h/semana" },
    { text: "5+", label: "⏱️ +5h/semana" },
    { text: "menu", label: "📌 Menu" },
  ];
}

function suggestionsLeadFlow() {
  return [
    { text: "menu", label: "📌 Menu" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
}

function suggestionsEnrollmentMode() {
  return [
    { text: "presencial", label: "🏫 Presencial" },
    { text: "online", label: "💻 Online" },
    { text: "menu", label: "📌 Menu" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
}

function suggestionsCertificarmeCursos() {
  const items = CERT_COURSES.map((c) => ({ text: c.name, label: c.label }));
  return [
    ...items,
    { text: "menu", label: "📌 Menu" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
}

function suggestionsChooseCourses(type) {
  const pick = buildCoursePicker(type, { availableOnly: true });
  return pick.suggestions;
}

// ============================
// Detectores (SIN IA para Fundación)
// ============================
function isGreeting(t) {
  const s = normalizeText(t);
  return ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hello", "hi"].includes(s);
}

function isMenuCommand(t) {
  const s = normalizeText(t);
  return ["menu", "opciones", "inicio", "start", "0"].includes(s);
}

function isHumanAdvisorRequest(t) {
  const s = normalizeText(t);
  if (s.includes("asesor humano")) return true;

  const wantsContact =
    s.includes("contactarme") ||
    s.includes("contactar") ||
    s.includes("comunicarme") ||
    s.includes("hablar con") ||
    s.includes("quiero hablar") ||
    s.includes("quiero contact");
  const mentionsAdvisor = s.includes("asesor") || s.includes("agente");
  const mentionsHuman = s.includes("humano") || s.includes("persona") || s.includes("agente");

  return (wantsContact && mentionsAdvisor) || (mentionsHuman && mentionsAdvisor);
}

function isBenefitsQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("beneficio") ||
    s.includes("beneficios") ||
    s.includes("ventaja") ||
    s.includes("que ofrece") ||
    s.includes("que me da") ||
    s.includes("beneficia")
  );
}

function isWorkWithUsQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("trabaja con nosotros") ||
    s.includes("trabajar con ustedes") ||
    s.includes("laborar con ustedes") ||
    s.includes("quiero laborar con ustedes") ||
    s.includes("quiero laborar") ||
    s.includes("quiero trabajar") ||
    s.includes("emplear instructor") ||
    s.includes("ser docente") ||
    s.includes("se docente") ||
    s.includes("empleo") ||
    s.includes("vacante") ||
    s.includes("voluntario") ||
    s.includes("colaborar") ||
    s.includes("alianza")
  );
}

function isWhatsAppNumberQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("numero de whatsapp") ||
    s.includes("numero whatsapp") ||
    s.includes("numero de whatsap") ||
    s.includes("numero whatsap") ||
    s.includes("numero de whatsaap") ||
    s.includes("numero whatsaap") ||
    s.includes("numero de wathsapp") ||
    s.includes("numero wathsapp") ||
    s.includes("numero de wsp") ||
    s.includes("numero wsp") ||
    s.includes("whatsapp") ||
    s.includes("whatsap") ||
    s.includes("whatsaap") ||
    s.includes("wsp")
  );
}

function isScholarshipQuery(t) {
  const s = normalizeText(t);
  return s.includes("beca") || s.includes("becas");
}

function isCourseDifferenceQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("diferencia curso gratuito") ||
    s.includes("diferencia entre curso gratuito y certificado") ||
    s.includes("curso gratuito y curso con certificado") ||
    s.includes("gratis o certificado") ||
    s.includes("cual es la diferencia entre cursos") ||
    (s.includes("diferencia") && s.includes("certificado") && s.includes("gratis"))
  );
}

function isSetecQuery(t) {
  const s = normalizeText(t);
  return s.includes("setec") || s.includes("que es setec") || s.includes("certificacion setec");
}

function isApprovalCriteriaQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("con cuanto apruebo") ||
    s.includes("con cuanto se aprueba") ||
    s.includes("cuanto necesito para aprobar") ||
    s.includes("con que nota apruebo") ||
    s.includes("con que nota se aprueba") ||
    s.includes("como se aprueba") ||
    s.includes("como aprobar") ||
    s.includes("requisitos de fundacion") ||
    s.includes("requisitos de aprobacion") ||
    s.includes("nota minima") ||
    s.includes("puntaje minimo") ||
    s.includes("criterio de aprobacion")
  );
}

function isLearningResourcesQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("que recursos incluye") ||
    s.includes("que incluye el curso") ||
    s.includes("material del curso") ||
    s.includes("incluye pdf") ||
    s.includes("incluye videos") ||
    s.includes("recursos del curso")
  );
}

function isModalitiesQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("modalidad") ||
    s.includes("es online") ||
    s.includes("es presencial") ||
    s.includes("online o presencial") ||
    s.includes("solo online") ||
    s.includes("tambien presencial")
  );
}

function isCorporateGroupsQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("empresa") ||
    s.includes("empresas") ||
    s.includes("grupo") ||
    s.includes("grupos") ||
    s.includes("institucion") ||
    s.includes("capacitacion corporativa") ||
    s.includes("descuento por grupo")
  );
}

function isInstructorQuery(t) {
  const s = normalizeText(t);
  return (
    s === "instructor" ||
    s.includes("instructor") ||
    s.includes("ser instructor") ||
    s.includes("quiero ser instructor") ||
    s.includes("convertirme en instructor") ||
    s.includes("conviertete en instructor") ||
    s.includes("postular como instructor") ||
    s.includes("docente de la fundacion") ||
    s.includes("quiero ser docente") ||
    s.includes("quiero ser maestro") ||
    s.includes("formar parte de la fundacion") ||
    (s.includes("maestro") && s.includes("fundacion")) ||
    (s.includes("docente") && s.includes("fundacion"))
  );
}

function isStoreQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("tienda solidaria") ||
    s.includes("comprar en la tienda") ||
    s.includes("productos solidarios")
  );
}

function isHistoryHelpQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("historial de conversaciones") ||
    s.includes("historial de conversacion") ||
    s.includes("historial de chats") ||
    s.includes("historial de chat") ||
    s.includes("ver mi historial") ||
    s.includes("ver historial") ||
    s.includes("dame mi historial") ||
    s.includes("dar mi historial") ||
    s.includes("me puedes dar mi historial") ||
    s.includes("mis conversaciones") ||
    s.includes("ver conversaciones anteriores") ||
    s.includes("conversaciones anteriores") ||
    s.includes("ver mis chats")
  );
}

function isFutureCoursesQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("cursos nuevos") ||
    s.includes("nuevos cursos") ||
    s.includes("cursos a futuro") ||
    s.includes("cursos futuros") ||
    s.includes("futuros cursos") ||
    s.includes("proximos cursos") ||
    s.includes("proximos") ||
    s.includes("cursos prox") ||
    s.includes("curso prox") ||
    s.includes("clases prox") ||
    s.includes("clase prox") ||
    s.includes("prox clases") ||
    s.includes("proxima clase") ||
    s.includes("proximas clases") ||
    s.includes("cuando son las clases que dicen prox") ||
    s.includes("cuando son los cursos proximos") ||
    s.includes("que cursos van a poner") ||
    s.includes("que cursos van a ponmer") ||
    s.includes("que cursos van a implementar") ||
    s.includes("que cursos van a crear") ||
    s.includes("que cursos piensan agregar") ||
    s.includes("que cursos piensan poner") ||
    s.includes("que cursos piensan implementar") ||
    s.includes("que cursos van a agregar") ||
    s.includes("que cursos tendran") ||
    s.includes("cursos que pondran a futuro") ||
    s.includes("que cursos pondran a futuro") ||
    s.includes("cuales son los cursos que pondran a futuro")
  );
}

function isFounderQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("fundadora") ||
    s.includes("quien fundo la fundacion") ||
    s.includes("quien es la fundadora") ||
    s.includes("fundadora de esta fundacion") ||
    s.includes("tatiana arias")
  );
}

function isTestimonialsQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("testimonios") ||
    s.includes("testimonio") ||
    s.includes("comentarios de la fundacion") ||
    s.includes("comentarios sobre la fundacion") ||
    s.includes("opiniones de la fundacion") ||
    s.includes("resenas de la fundacion") ||
    s.includes("que dicen de la fundacion") ||
    s.includes("que dicen sobre la fundacion")
  );
}

function isCourseSuggestionQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("que curso me sugieren") ||
    s.includes("que curson me sugieren") ||
    s.includes("que cursos me sugieren") ||
    s.includes("que curso me recomiendan") ||
    s.includes("que cursos me recomiendan") ||
    s.includes("me puedes sugerir un curso") ||
    s.includes("me podrias sugerir un curso") ||
    s.includes("que curso me recomienda") ||
    s.includes("me sugiere algo")
  );
}

function isAllCoursesQuery(t) {
  const s = normalizeText(t);
  return (
    s === "curso" ||
    s === "cursos" ||
    s.includes("cuales son los cursos que hay") ||
    s.includes("cuales son los cursos") ||
    s.includes("que cursos hay") ||
    s.includes("que cursos tienen") ||
    s.includes("quiero ver los cursos") ||
    s.includes("lista de cursos") ||
    s.includes("dame los cursos")
  );
}

function isAdvisorTestIntentQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("test de ayuda") ||
    s.includes("test ayuda") ||
    s.includes("quiero hacer un test") ||
    s.includes("quiero hacer test") ||
    s.includes("quiero hacer una prueba") ||
    s.includes("quiero hacer una prueba para saber") ||
    s.includes("prueba para saber que curso") ||
    s.includes("como puedo saber que curso") ||
    s.includes("como saber que curso") ||
    s.includes("que curso esta a mi gusto") ||
    s.includes("curso a mi gusto") ||
    s.includes("que curso va conmigo") ||
    s.includes("que curso es para mi") ||
    s.includes("cual curso me conviene") ||
    s.includes("ayudame a elegir curso") ||
    s.includes("ayudame a escoger curso")
  );
}

function isTodayDateQuery(t) {
  const s = normalizeText(t);
  if (s.includes("clases")) return false;
  if (["fecha", "dia", "hoy", "fecha hoy", "dia hoy", "fecha actual", "dia actual"].includes(s)) return true;
  return (
    s.includes("que dia estamos hoy") ||
    s.includes("que dia estamos") ||
    s.includes("dia que estamos") ||
    s.includes("fecha que estamos") ||
    s.includes("que dia es hoy") ||
    s.includes("que fecha es hoy") ||
    s.includes("que fecha estamos") ||
    s.includes("fecha de hoy") ||
    s.includes("fecha actual") ||
    s.includes("dia de hoy")
  );
}

function isCurrentTimeQuery(t) {
  const s = normalizeText(t);
  if (s.includes("clases")) return false;
  if (["hora", "hora actual", "hora de hoy", "hora ahora"].includes(s)) return true;
  return (
    s.includes("que hora estamos") ||
    s.includes("hora que estamos") ||
    s.includes("que hora es") ||
    s.includes("que hora es ahorita") ||
    s.includes("que hora es ahora") ||
    s.includes("hora actual") ||
    s.includes("hora en ecuador") ||
    s.includes("hora ecuatoriana")
  );
}

function isClassTimeQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("aque hora son las clases") ||
    s.includes("a que hora son las clases") ||
    s.includes("a que hora dan las clases") ||
    s.includes("que hora son las clases") ||
    s.includes("que dia son las clases") ||
    s.includes("que dias son las clases") ||
    s.includes("que día son las clases") ||
    s.includes("horario de clases")
  );
}

function isClassStartQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("cuando son las clases") ||
    s.includes("cuando empiezan las clases") ||
    s.includes("cuando comienzan las clases") ||
    s.includes("cuando inician las clases") ||
    s.includes("cuando abren las clases") ||
    s.includes("cuando inicia el curso") ||
    s.includes("cuando comienza el curso")
  );
}

function isPasswordRecoveryQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("recuperar contrasena") ||
    s.includes("recuperar mi contrasena") ||
    s.includes("olvide mi contrasena") ||
    s.includes("olvidé mi contrasena") ||
    s.includes("olvidar contrasena") ||
    s.includes("cambiar contrasena") ||
    s.includes("resetear contrasena") ||
    s.includes("restablecer contrasena") ||
    s.includes("no puedo iniciar sesion") ||
    s.includes("no puedo entrar a mi cuenta") ||
    s.includes("acceso a mi cuenta") ||
    s.includes("clave de mi cuenta") ||
    s.includes("contrasena de mi cuenta") ||
    s.includes("password de mi cuenta")
  );
}

function isAccountRegistrationQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("crear una cuenta") ||
    s.includes("crear cuenta") ||
    s.includes("como crear una cuenta") ||
    s.includes("como crear cuenta") ||
    s.includes("como me creo una cuenta") ||
    s.includes("registrarme") ||
    s.includes("registrar") ||
    s.includes("como registrarme") ||
    s.includes("como me registro") ||
    s.includes("quiero registrarme en la fundacion") ||
    s.includes("quiero crear cuenta en la fundacion") ||
    s.includes("quiero registrarme") ||
    s.includes("quiero crear una cuenta") ||
    s.includes("abrir una cuenta") ||
    s.includes("abrir cuenta") ||
    s.includes("tienda solidaria mi cuenta") ||
    s.includes("tienda solidaria micuenta")
  );
}

function isAffirmation(t) {
  const s = normalizeText(t);
  return ["si", "sí", "ok", "okay", "de acuerdo", "esta bien", "está bien", "listo", "vale", "perfecto", "gracias", "bien"].includes(s);
}

function isCertificarmeQuery(t) {
  const s = normalizeText(t);
  return s.includes("certificarme") || s.includes("como certificarme") || s.includes("certificacion") || s.includes("certificar");
}

function isEnrollmentStatusQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("ya estoy inscr") ||
    s.includes("ya me inscrib") ||
    s.includes("estoy inscrito") ||
    s.includes("verificar inscrip") ||
    s.includes("estado de inscrip") ||
    s.includes("como se si ya estoy inscr") ||
    s.includes("como se que ya estoy inscr")
  );
}

// ✅ NUEVO: pagos
function isPaymentQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("pago") ||
    s.includes("pagar") ||
    s.includes("payphone") ||
    s.includes("transferencia") ||
    s.includes("transferir") ||
    s.includes("metodo de pago") ||
    s.includes("metodos de pago") ||
    s.includes("forma de pago") ||
    s.includes("formas de pago") ||
    s.includes("como pago") ||
    s.includes("como pagar")
  );
}

function isMissionQuery(t) {
  const s = normalizeText(t);
  return s === "mision" || s.includes("mision");
}

function isVisionQuery(t) {
  const s = normalizeText(t);
  return s === "vision" || s.includes("vision");
}

function isValuesQuery(t) {
  const s = normalizeText(t);
  return s.includes("valores") || s.includes("principios");
}

function isPillarsQuery(t) {
  const s = normalizeText(t);
  return s.includes("pilares") || s.includes("nuestra diferencia") || s.includes("diferencia");
}

function isAboutUsQuery(t) {
  const s = normalizeText(t);
  return s.includes("quienes son") || s.includes("quienes somos") || s.includes("historia") || s.includes("acerca de") || s.includes("nosotros");
}

function isFoundationQuery(t) {
  const s = normalizeText(t);
  if (s.includes("universidad") || s.includes("ciudad")) return false;
  const keys = [
    "fundacion",
    "capacitamente",
    "curso",
    "cursos",
    "que cursos hay",
    "lista de cursos",
    "certificado",
    "certificacion",
    "certificar",
    "certificarme",
    "donar",
    "donacion",
    "donaciones",
    "paypal",
    "transferencia",
    "whatsapp",
    "correo",
    "contacto",
    "tatiana",
    "yadira",
    "formador de formadores",
    "inteligencia emocional",
    "tecnologia para padres",
    "tecnologia para educadores",
    "horario",
    "horarios",
    "inscribirme",
    "inscripcion",
    "beneficio",
    "beneficios",
    "ventajas",
    "becas",
    "setec",
    "aprobacion",
    "apruebo",
    "aprobar",
    "requisitos",
    "modalidad",
    "online",
    "presencial",
    "empresa",
    "grupos",
    "instructor",
    "docente",
    "maestro",
    "formar parte",
    "tienda solidaria",
    "mision",
    "vision",
    "valores",
    "pilares",
    "fundadora",
    "testimonios",
    "comentarios",
    "quienes somos",
    "acerca de",
    "nosotros",
    "trabaja con nosotros",
    "trabajar",
    "vacante",
    "empleo",
    "voluntario",
    "colaborar",
    "alianza",
  ];
  return keys.some((k) => s.includes(normalizeText(k)));
}

// ============================
// Flujos
// ============================
const certFlow = new Map();
const advisorFlow = new Map();
const leadFlow = new Map();
const scheduleFlow = new Map();
const certificarmeFlow = new Map();
const enrollCheckFlow = new Map(); // ✅ nuevo
const scheduleJustSaved = new Map();
const justCancelled = new Set();
const scholarshipIntent = new Map();

const lastSchedulePrefId = new Map();
const courseContext = new Map();
const profileCache = new Map(); // sessionId -> {nombre, cedula, whatsapp, email, modalidad, sede, franja, dias, schedule_pref_id}

function resetFlows(sessionId) {
  certFlow.delete(sessionId);
  advisorFlow.delete(sessionId);
  leadFlow.delete(sessionId);
  scheduleFlow.delete(sessionId);
  certificarmeFlow.delete(sessionId);
  enrollCheckFlow.delete(sessionId); // ✅ nuevo
}

// ============================
// Supabase helpers
// ============================
async function getSession(sessionId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("session_id, user_key, conversation_number")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getNextConversationNumber(userKey) {
  try {
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("conversation_number")
      .eq("user_key", userKey)
      .order("conversation_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const last = data && typeof data.conversation_number === "number" ? data.conversation_number : 0;
    return last + 1;
  } catch {
    return null;
  }
}

async function insertSessionRow(row) {
  const { error } = await supabase.from("chat_sessions").insert([row]);
  if (!error) return;

  const msg = String(error.message || "").toLowerCase();
  if (msg.includes("conversation_number")) {
    const clone = { ...row };
    delete clone.conversation_number;
    const { error: e2 } = await supabase.from("chat_sessions").insert([clone]);
    if (e2) throw e2;
    return;
  }
  throw error;
}

// 🔧 CAMBIO CLAVE: ensureSession ya NO inserta el menú automáticamente (evita duplicados)
async function ensureSession(sessionId, userKey) {
  if (!supabase) return { created: false };

  const now = new Date().toISOString();
  const existing = await getSession(sessionId);

  if (!existing) {
    const nextNum = await getNextConversationNumber(userKey);
    const row = { session_id: sessionId, user_key: userKey, last_seen: now };
    if (typeof nextNum === "number") row.conversation_number = nextNum;
    await insertSessionRow(row);
    return { created: true };
  }

  if (existing.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const { error: upErr } = await supabase.from("chat_sessions").update({ last_seen: now }).eq("session_id", sessionId);
  if (upErr) throw upErr;

  return { created: false };
}

async function touchSessionLastMessage(sessionId, userKey, previewText) {
  if (!supabase) return;

  const now = new Date().toISOString();
  const preview = String(previewText || "").slice(0, 200);

  const s = await getSession(sessionId);
  if (!s || s.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const { error: upErr } = await supabase
    .from("chat_sessions")
    .update({ last_seen: now, last_message_at: now, last_message_preview: preview })
    .eq("session_id", sessionId);

  if (upErr) throw upErr;
}

async function insertChatMessage(sessionId, userKey, role, content) {
  if (!supabase) return;

  const s = await getSession(sessionId);
  if (!s || s.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const { error } = await supabase.from("chat_messages").insert([{ session_id: sessionId, role, content }]);
  if (error) throw error;
}

// ✅ Nuevo: insertar menú SOLO cuando se crea desde /sessions
async function insertWelcomeMenu(sessionId, userKey) {
  const reply = menuOpcionesTexto();
  await insertChatMessage(sessionId, userKey, "bot", reply);
  await touchSessionLastMessage(sessionId, userKey, reply);
}

// ============================
// PIN (Fijar conversación) - opcional
// ============================
async function setPinned(sessionId, userKey, pinned) {
  if (!supabase) return;

  const s = await getSession(sessionId);
  if (!s || s.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const now = new Date().toISOString();
  const payload = pinned ? { pinned: true, pinned_at: now } : { pinned: false, pinned_at: null };

  const { error } = await supabase.from("chat_sessions").update(payload).eq("session_id", sessionId);
  if (error) throw error;
}

// ============================
// Certificado (mejorado)
// ============================
function extractOrderNumber(text) {
  const m = String(text || "").match(/\b\d{4}\b/);
  return m ? m[0] : "";
}

function extractCourse(text, orderNumber) {
  let s = String(text || "");
  if (orderNumber) s = s.replace(orderNumber, "");
  s = s.replace(/[-,:]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function certAskText() {
  return `ESTADO DE CERTIFICADO

Escribe el NUMERO DE PEDIDO (4 digitos) y el NOMBRE DEL CURSO.

Ejemplo:
9039 - Inteligencia Emocional

(Para salir escribe: MENU)`;
}

async function getCertificateStatus(orderNumber, curso) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("certificate_status")
    .select("estado, updated_at, curso")
    .eq("numero_de_pedido", orderNumber)
    .ilike("curso", `%${curso}%`)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0];
}

function humanDateEC(iso) {
  try {
    return new Date(iso).toLocaleString("es-EC");
  } catch {
    return String(iso || "");
  }
}

function certificateReplyFromRow(row) {
  const estado = normalizeText(row.estado || "");
  const updated = humanDateEC(row.updated_at);

  if (estado === "listo") {
    return `✅ CERTIFICADO LISTO

Curso: ${row.curso}
Actualizado: ${updated}

Para descargar tu certificado, entra a tu cuenta de la Fundacion.
Una vez que culminaste tu curso, tu certificado lo puedes descargar directamente.

Si aún no lo recibiste, escríbenos:
📱 ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}`;
  }

  if (estado === "en proceso" || estado === "en_proceso") {
    return `⏳ CERTIFICADO EN PROCESO

Curso: ${row.curso}
Actualizado: ${updated}

Sugerencia: vuelve a consultar más tarde.`;
  }

  if (estado === "no listo" || estado === "no_listo") {
    return `⚠️ CERTIFICADO AÚN NO LISTO

Curso: ${row.curso}
Actualizado: ${updated}

Para descargar tu certificado, entra a tu cuenta de la Fundacion.
Una vez que culminaste tu curso, tu certificado lo puedes descargar directamente.

Si necesitas ayuda, contáctanos:
📱 ${CONTACT_PHONE_1}
☎️ ${CONTACT_PHONE_2}
✉️ ${CONTACT_EMAIL}`;
  }

  return `📄 ESTADO DE CERTIFICADO

Curso: ${row.curso}
Estado: ${row.estado}
Actualizado: ${updated}`;
}

// ============================
// Leads (inscripción) + schedule_pref_id
// ============================
async function saveLead(userKey, sessionId, data) {
  if (!supabase) return;

  const schedulePrefId = data?.schedule_pref_id ?? null;

  const baseWithEstado = {
    user_key: userKey,
    session_id: sessionId,
    nombre: data.nombre,
    curso: data.curso,
    estado: "preinscrito",
    modalidad: data.modalidad || null,
    sede: data.sede || null,
  };

  const baseNoEstado = {
    user_key: userKey,
    session_id: sessionId,
    nombre: data.nombre,
    curso: data.curso,
    modalidad: data.modalidad || null,
    sede: data.sede || null,
  };

  const baseMinimalWithEstado = {
    user_key: userKey,
    session_id: sessionId,
    nombre: data.nombre,
    curso: data.curso,
    estado: "preinscrito",
  };

  const baseMinimal = {
    user_key: userKey,
    session_id: sessionId,
    nombre: data.nombre,
    curso: data.curso,
  };

  const buildAttempts = (base) => [
    // Esquemas con email/correo + cédula
    { ...base, whatsapp: data.whatsapp, email: data.email, cedula: data.cedula, schedule_pref_id: schedulePrefId },
    { ...base, WhatsApp: data.whatsapp, email: data.email, cedula: data.cedula, schedule_pref_id: schedulePrefId },
    { ...base, whatsapp: data.whatsapp, correo: data.email, cedula: data.cedula, schedule_pref_id: schedulePrefId },
    { ...base, WhatsApp: data.whatsapp, correo: data.email, cedula: data.cedula, schedule_pref_id: schedulePrefId },
    { ...base, whatsapp: data.whatsapp, correo_electronico: data.email, cedula: data.cedula, schedule_pref_id: schedulePrefId },
    { ...base, WhatsApp: data.whatsapp, correo_electronico: data.email, cedula: data.cedula, schedule_pref_id: schedulePrefId },
    // Esquemas sin schedule_pref_id
    { ...base, whatsapp: data.whatsapp, email: data.email, cedula: data.cedula },
    { ...base, WhatsApp: data.whatsapp, email: data.email, cedula: data.cedula },
    { ...base, whatsapp: data.whatsapp, correo: data.email, cedula: data.cedula },
    { ...base, WhatsApp: data.whatsapp, correo: data.email, cedula: data.cedula },
    { ...base, whatsapp: data.whatsapp, correo_electronico: data.email, cedula: data.cedula },
    { ...base, WhatsApp: data.whatsapp, correo_electronico: data.email, cedula: data.cedula },
    // Fallback legado (si la tabla aún no tiene email/cedula)
    { ...base, whatsapp: data.whatsapp, schedule_pref_id: schedulePrefId },
    { ...base, WhatsApp: data.whatsapp, schedule_pref_id: schedulePrefId },
    { ...base, whatsapp: data.whatsapp },
    { ...base, WhatsApp: data.whatsapp },
  ];

  const tryInsertAttempts = async (attempts) => {
    let lastErr = null;
    for (const row of attempts) {
      const { error } = await supabase.from("leads").insert([row]);
      if (!error) return null;
      lastErr = error;
    }
    return lastErr;
  };

  // Intento principal: guarda estado=preinscrito automáticamente
  const errWithEstado = await tryInsertAttempts(buildAttempts(baseWithEstado));
  if (!errWithEstado) return;

  // Fallback de compatibilidad: por si faltan columnas nuevas (estado/modalidad/sede)
  const msg = String(errWithEstado.message || "").toLowerCase();
  const missingEstado = msg.includes("column") && msg.includes("estado");
  const missingModalidad = msg.includes("column") && msg.includes("modalidad");
  const missingSede = msg.includes("column") && msg.includes("sede");

  if (missingEstado || missingModalidad || missingSede) {
    const baseA = missingEstado ? baseMinimal : baseMinimalWithEstado;
    const errNoExtras = await tryInsertAttempts(buildAttempts(baseA));
    if (!errNoExtras) return;

    // Compatibilidad adicional para instalaciones sin columna estado
    const errNoEstado = await tryInsertAttempts(buildAttempts(baseNoEstado));
    if (!errNoEstado) return;
    throw errNoEstado;
  }

  throw errWithEstado;
}

async function saveLeadDraft(userKey, sessionId, data) {
  const draft = { ...data, curso: data.curso || "PENDIENTE" };
  return saveLead(userKey, sessionId, draft);
}

async function updateLeadCourseForSession(userKey, sessionId, curso) {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("leads")
    .update({ curso })
    .match({ user_key: userKey, session_id: sessionId })
    .select("id")
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

function extractWhatsapp(text) {
  const raw = String(text || "").replace(/\s+/g, "");
  const m = raw.match(/(\+?\d{9,15})/);
  return m ? m[1] : "";
}

function normalizeEcuadorWhatsApp(text) {
  const raw = String(text || "").replace(/\s+/g, "");
  const digits = raw.replace(/\D/g, "");

  // Formato local: 09XXXXXXXX
  if (/^09\d{8}$/.test(digits)) return `+593${digits.slice(1)}`;
  // Formato internacional sin +: 5939XXXXXXXX
  if (/^5939\d{8}$/.test(digits)) return `+${digits}`;
  // Formato internacional con +: +5939XXXXXXXX
  if (/^\+5939\d{8}$/.test(raw)) return raw;

  return "";
}

function isValidEcuadorWhatsApp(input) {
  return !!normalizeEcuadorWhatsApp(input);
}

function isStrictEcuadorWhatsApp(input) {
  const raw = String(input || "").trim();
  return /^09\d{8}$/.test(raw) || /^5939\d{8}$/.test(raw) || /^\+5939\d{8}$/.test(raw);
}

function extractEmail(text) {
  const s = String(text || "").trim().toLowerCase();
  const m = s.match(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/);
  return m ? m[0].toLowerCase() : "";
}

function isValidEmail(input) {
  return !!extractEmail(input);
}

function extractCedula(text) {
  return String(text || "").replace(/\D/g, "");
}

function isValidCedula(input) {
  const raw = String(input || "").trim();
  return /^\d{10}$/.test(raw);
}

function maskCedula(value) {
  const c = extractCedula(value);
  if (!c) return "";
  if (c.length <= 4) return "*".repeat(c.length);
  return `${"*".repeat(c.length - 4)}${c.slice(-4)}`;
}

function isValidFullName(input) {
  const raw = String(input || "").trim();
  if (!raw) return false;
  if (/\d/.test(raw)) return false;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const lettersOnly = parts.every((p) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}$/.test(p));
  return lettersOnly;
}

// ============================
// Preferencia de horario (GUARDADO + devuelve ID si existe)
// ============================
function pickScheduleId(row) {
  if (!row) return null;
  return row.id ?? row.identificacion ?? row["identificación"] ?? row.identificacion_id ?? null;
}

async function saveSchedule(userKey, sessionId, data) {
  if (!supabase) return { id: null };

  const try1 = await supabase
    .from("schedule_preferences")
    .insert([{ user_key: userKey, session_id: sessionId, franja: data.franja, dias: data.dias }])
    .select("*");

  if (!try1.error) {
    const row = try1.data && try1.data[0] ? try1.data[0] : null;
    return { id: pickScheduleId(row), row };
  }

  const msg = String(try1.error.message || "").toLowerCase();

  if (msg.includes("column") && (msg.includes("franja") || msg.includes("dias"))) {
    const pref = JSON.stringify({ franja: data.franja, dias: data.dias });
    const try2 = await supabase
      .from("schedule_preferences")
      .insert([{ user_key: userKey, session_id: sessionId, preferencia: pref }])
      .select("*");

    if (try2.error) throw try2.error;

    const row = try2.data && try2.data[0] ? try2.data[0] : null;
    return { id: pickScheduleId(row), row };
  }

  throw try1.error;
}

// ============================
// Asesor (recomendador) - SIN IA
// ============================
function recommendCourse({ persona, interes, tiempo }) {
  const p = normalizeText(persona);
  const i = normalizeText(interes);
  const t = normalizeText(tiempo);

  if (p.includes("padre") || p.includes("madre")) {
    return { curso: "Tecnología para Padres ($15)", motivo: "ideal si quieres acompañar y guiar mejor el uso de tecnología en casa." };
  }

  if (p.includes("docente")) {
    if (i.includes("tecnolog")) {
      return { curso: "Tecnología para Educadores (Gratis)", motivo: "enfocado a herramientas y recursos útiles para docentes." };
    }
    return { curso: "Formador de Formadores ($120)", motivo: "perfecto para fortalecer habilidades de enseñanza y facilitación." };
  }

  if (i.includes("habilidades") || i.includes("blandas")) {
    return { curso: "Inteligencia Emocional ($15)", motivo: "fortalece comunicación, manejo de emociones y relaciones." };
  }

  if (i.includes("educa")) {
    return { curso: "Formador de Formadores ($120)", motivo: "te ayuda a estructurar sesiones y enseñar con mejor metodología." };
  }

  if (i.includes("tecnolog")) {
    return { curso: "Tecnología para Educadores (Gratis)", motivo: "una base útil para avanzar rápido sin costo." };
  }

  if (t === "1-2") {
    return { curso: "Inteligencia Emocional ($15)", motivo: "es una opción ligera y muy aplicable día a día." };
  }

  return { curso: "Formador de Formadores ($120)", motivo: "muy completo si quieres una formación sólida." };
}

// ============================
// IA en memoria + límites
// ============================
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 300;

const MAX_DAILY_AI_CALLS = Number(process.env.MAX_DAILY_AI_CALLS || 50);
const aiCallsByUserDay = new Map(); // key: YYYY-MM-DD|userKey -> count

const aiLastCallAt = new Map();

function getDayKeyEC() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getEcuadorNow() {
  const now = new Date();
  const fechaLarga = new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const hora24 = new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return { fechaLarga, hora24 };
}

async function buildEcuadorNowReplyWithAI(userMessage, mode) {
  const now = getEcuadorNow();
  if (mode === "date") {
    return `Hoy en Ecuador estamos a:\n➡️ ${now.fechaLarga}`;
  }
  return `La hora actual en Ecuador es:\n➡️ ${now.hora24} (America/Guayaquil)`;
}

function aiUserDayKey(userKey) {
  const day = getDayKeyEC();
  return `${day}|${String(userKey || "").slice(0, 500)}`;
}

function canUseAI(userKey) {
  const k = aiUserDayKey(userKey);
  const count = aiCallsByUserDay.get(k) || 0;
  return count < MAX_DAILY_AI_CALLS;
}

function incAI(userKey) {
  const k = aiUserDayKey(userKey);
  const count = aiCallsByUserDay.get(k) || 0;
  aiCallsByUserDay.set(k, count + 1);
}

const housekeepingTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastAccess > SESSION_TTL_MS) sessions.delete(sid);
  }
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const extra = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < extra; i++) sessions.delete(ordered[i][0]);
  }

  // limpia rateBuckets viejos
  const cutoff = now - RATE_LIMIT_WINDOW_MS * 3;
  for (const [k, b] of rateBuckets.entries()) {
    if (b.start < cutoff) rateBuckets.delete(k);
  }

  // limpia contadores IA de días anteriores
  const today = getDayKeyEC();
  for (const [k] of aiCallsByUserDay.entries()) {
    if (!k.startsWith(`${today}|`)) aiCallsByUserDay.delete(k);
  }
}, 60 * 1000);
if (typeof housekeepingTimer.unref === "function") housekeepingTimer.unref();

async function geminiSendWithRetry(sessionObj, userMessage) {
  let lastErr = null;

  for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt++) {
    try {
      const out = await sessionObj.chat.sendMessage({ message: userMessage });
      return out;
    } catch (e) {
      lastErr = e;
      const status = extractStatus(e);
      const msg = extractMessage(e);

      const retryable = isRetryableGeminiError(status, msg);
      if (!retryable || attempt === GEMINI_RETRIES) throw e;

      const waitMs = GEMINI_RETRY_BASE_MS * (attempt + 1);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

// ============================
// ✅ VERIFICAR INSCRIPCIÓN (leads)
// ============================
function buildPhoneVariants(phone) {
  const raw = String(phone || "").trim().replace(/\s+/g, "");
  const digits = raw.replace(/\D/g, "");
  const rawNoPlus = raw.replace(/^\+/, "");
  const variants = new Set();

  if (raw) variants.add(raw);
  if (rawNoPlus) variants.add(rawNoPlus);

  if (rawNoPlus && !rawNoPlus.startsWith("0") && !raw.startsWith("+")) {
    variants.add(`+${rawNoPlus}`);
  }

  return {
    variants: [...variants].filter(Boolean),
    lastDigits: digits.length >= 7 ? digits.slice(-9) : digits,
  };
}

async function getEnrollmentsByName(nombre) {
  if (!supabase) return [];

  const q = String(nombre || "").trim();
  if (!q) return [];

  const { data, error } = await supabase
    .from("leads")
    .select("nombre, curso, created_at")
    .ilike("nombre", `%${q}%`)
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) throw error;
  return data || [];
}

async function queryLeadsByPhoneColumn(col, phone, nombreLike) {
  const { variants, lastDigits } = buildPhoneVariants(phone);

  try {
    let q1 = supabase.from("leads").select("nombre, curso, created_at");

    if (variants.length) q1 = q1.in(col, variants);
    else q1 = q1.eq(col, String(phone || "").trim());

    if (nombreLike) q1 = q1.ilike("nombre", `%${String(nombreLike).trim()}%`);

    q1 = q1.order("created_at", { ascending: false }).limit(25);

    const r1 = await q1;
    if (r1.error) throw r1.error;
    if (r1.data && r1.data.length) return r1.data;

    if (lastDigits && lastDigits.length >= 7) {
      let q2 = supabase.from("leads").select("nombre, curso, created_at");
      q2 = q2.ilike(col, `%${lastDigits}%`);
      if (nombreLike) q2 = q2.ilike("nombre", `%${String(nombreLike).trim()}%`);
      q2 = q2.order("created_at", { ascending: false }).limit(25);

      const r2 = await q2;
      if (r2.error) throw r2.error;
      return r2.data || [];
    }

    return [];
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes("column") && msg.includes(col.toLowerCase())) return null;
    throw e;
  }
}

async function getEnrollmentsByWhatsAppAndName(whatsapp, nombreLike) {
  if (!supabase) return [];

  const r1 = await queryLeadsByPhoneColumn("whatsapp", whatsapp, nombreLike);
  if (r1 === null) {
    const r2 = await queryLeadsByPhoneColumn("WhatsApp", whatsapp, nombreLike);
    return r2 === null ? [] : r2;
  }

  if (r1.length) return r1;

  const r2 = await queryLeadsByPhoneColumn("WhatsApp", whatsapp, nombreLike);
  return r2 === null ? [] : r2;
}

function formatEnrollmentsReply(nombre, rows) {
  const cursos = [...new Set((rows || []).map((r) => r.curso).filter(Boolean))];

  if (cursos.length === 0) {
    return `Encontré registros a nombre de: ${nombre}, pero no veo el curso guardado.

Si deseas inscribirte ahora escribe: INSCRIBIRME`;
  }

  return `✅ Sí, encontré inscripción a tu nombre.

Nombre: ${rows[0]?.nombre || nombre}
Cursos registrados:
${cursos.map((c) => `- ${c}`).join("\n")}

Si deseas inscribirte a otro curso escribe: INSCRIBIRME`;
}

// ============================
// Routes
// ============================
app.get("/health", (req, res) => res.status(200).send("ok"));

// Lista sesiones (con PIN si existe)
app.get("/sessions", async (req, res) => {
  const rl = checkRateLimit(req);
  if (!rl.ok) return sendJson(res, { error: "Demasiadas solicitudes. Intenta en unos segundos." }, 429);

  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const userKey = getUserKey(req);
    const limit = Math.min(Number(req.query.limit || 30), 100);

    const tryQuery = async ({ includePinned, includeConv }) => {
      const fields = [
        "session_id",
        "created_at",
        "last_seen",
        "last_message_at",
        "last_message_preview",
        includeConv ? "conversation_number" : null,
        includePinned ? "pinned" : null,
        includePinned ? "pinned_at" : null,
      ]
        .filter(Boolean)
        .join(", ");

      let q = supabase.from("chat_sessions").select(fields).eq("user_key", userKey);

      if (includePinned) {
        q = q
          .order("pinned", { ascending: false, nullsFirst: false })
          .order("pinned_at", { ascending: false, nullsFirst: false });
      }

      q = q
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit);

      return await q;
    };

    let r = await tryQuery({ includePinned: true, includeConv: true });

    if (r.error) {
      const msg = String(r.error.message || "").toLowerCase();

      if (msg.includes("pinned")) r = await tryQuery({ includePinned: false, includeConv: true });

      if (r.error && String(r.error.message || "").toLowerCase().includes("conversation_number")) {
        r = await tryQuery({ includePinned: false, includeConv: false });
      }
    }

    if (r.error) return sendJson(res, { error: r.error.message }, 500);
    return sendJson(res, { sessions: r.data || [] }, 200);
  } catch (e) {
    return sendJson(res, { error: "Error en /sessions", details: String(e?.message || e) }, 500);
  }
});

// Crear nueva conversación
app.post("/sessions", async (req, res) => {
  const rl = checkRateLimit(req);
  if (!rl.ok) return sendJson(res, { error: "Demasiadas solicitudes. Intenta en unos segundos." }, 429);

  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const userKey = getUserKey(req);
    const sessionId = newSessionId();

    await ensureSession(sessionId, userKey);
    // ✅ aquí sí insertamos el menú como primer mensaje (solo al crear con botón "Nueva")
    await insertWelcomeMenu(sessionId, userKey);

    return sendJson(res, { sessionId }, 200);
  } catch (e) {
    return sendJson(res, { error: "Error creando sesión", details: String(e?.message || e) }, 500);
  }
});

// PIN / UNPIN
app.post("/session/:sessionId/pin", async (req, res) => {
  const rl = checkRateLimit(req);
  if (!rl.ok) return sendJson(res, { error: "Demasiadas solicitudes. Intenta en unos segundos." }, 429);

  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const sessionId = String(req.params.sessionId || "").trim();
    const userKey = getUserKey(req);
    const pinned = !!req.body?.pinned;

    try {
      await setPinned(sessionId, userKey, pinned);
    } catch (e) {
      const msg = String(e?.message || "").toLowerCase();
      if (msg.includes("pinned")) {
        return sendJson(res, { error: "Tu tabla chat_sessions no tiene columnas de PIN.", hint: "Agrega columnas pinned y pinned_at." }, 400);
      }
      throw e;
    }

    return sendJson(res, { ok: true, sessionId, pinned }, 200);
  } catch (e) {
    const status = extractStatus(e) || 500;
    return sendJson(res, { error: "Error en pin", details: String(e?.message || e) }, status);
  }
});

// Eliminar conversación
app.delete("/session/:sessionId", async (req, res) => {
  const rl = checkRateLimit(req);
  if (!rl.ok) return sendJson(res, { error: "Demasiadas solicitudes. Intenta en unos segundos." }, 429);

  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return sendJson(res, { error: "Falta sessionId" }, 400);

    const userKey = getUserKey(req);

    const s = await getSession(sessionId);
    if (!s) return sendJson(res, { error: "Sesión no encontrada." }, 404);
    if (s.user_key !== userKey) return sendJson(res, { error: "No autorizado para borrar esta sesión." }, 403);

    const { error: mErr } = await supabase.from("chat_messages").delete().eq("session_id", sessionId);
    if (mErr) return sendJson(res, { error: "Error borrando mensajes", details: mErr.message }, 500);

    const { error: dErr } = await supabase.from("chat_sessions").delete().eq("session_id", sessionId);
    if (dErr) return sendJson(res, { error: "Error borrando sesión", details: dErr.message }, 500);

    sessions.delete(sessionId);
    resetFlows(sessionId);
    lastSchedulePrefId.delete(sessionId);
    courseContext.delete(sessionId);
    justCancelled.delete(sessionId);
    aiLastCallAt.delete(sessionId);

    return sendJson(res, { ok: true, sessionId }, 200);
  } catch (e) {
    const status = extractStatus(e) || 500;
    return sendJson(res, { error: "Error interno", details: String(e?.message || e) }, status);
  }
});

// Historial
app.get("/history/:sessionId", async (req, res) => {
  const rl = checkRateLimit(req);
  if (!rl.ok) return sendJson(res, { error: "Demasiadas solicitudes. Intenta en unos segundos." }, 429);

  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const userKey = getUserKey(req);
    const sessionId = String(req.params.sessionId || "").trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const s = await getSession(sessionId);
    if (!s || s.user_key !== userKey) return sendJson(res, { error: "Sesión no encontrada." }, 404);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) return sendJson(res, { error: error.message }, 500);

    return sendJson(res, { sessionId, messages: data || [] }, 200);
  } catch (e) {
    return sendJson(res, { error: "Error en historial", details: String(e?.message || e) }, 500);
  }
});

// ============================
// Chat principal
// ============================
app.post("/chat", async (req, res) => {
  // 🔧 para que el catch NO pierda el sessionId
  let sessionId = "";
  try {
    const rl = checkRateLimit(req);
    if (!rl.ok) {
      return sendJson(
        res,
        {
          reply: "Estás enviando mensajes muy rápido. Intenta en unos segundos.",
          sessionId: String(req.body?.sessionId || ""),
          suggestions: suggestionsMenu(),
        },
        429
      );
    }

    const userMessage = clampMessage(req.body?.message);
    sessionId = String(req.body?.sessionId || "").trim();

    if (!userMessage) return sendJson(res, { reply: "Mensaje no proporcionado." }, 400);
    if (!sessionId) sessionId = newSessionId();

    const userKey = getUserKey(req);

    if (supabase) await ensureSession(sessionId, userKey);

    if (supabase) {
      await insertChatMessage(sessionId, userKey, "user", userMessage);
      await touchSessionLastMessage(sessionId, userKey, userMessage);
    }

    const t = normalizeText(userMessage);

    if (t !== "cancelar") {
      justCancelled.delete(sessionId);
    }

    // ====== comandos globales ======
    if (isGreeting(t) || isMenuCommand(t)) {
      resetFlows(sessionId);
      courseContext.delete(sessionId);
      scholarshipIntent.delete(sessionId);

      const reply = menuOpcionesTexto();
      const wasJustCancelled = justCancelled.has(sessionId);
      justCancelled.delete(sessionId);
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: wasJustCancelled ? suggestionsOnlyMenu() : suggestionsMenu() }, 200);
    }

    if (t === "cancelar") {
      resetFlows(sessionId);
      justCancelled.add(sessionId);
      scholarshipIntent.delete(sessionId);
      const reply = "✅ Listo. Cancelé el proceso. Escribe MENU para ver opciones.";
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    // ====== pagos (Transferencia / PayPhone) ======
    if (isPaymentQuery(userMessage)) {
      resetFlows(sessionId);
      courseContext.set(sessionId, "cert");

      const reply = pagosTexto();

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }

      return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
    }

    // ====== FLUJO: verificar si ya está inscrito ======
    if (enrollCheckFlow.has(sessionId)) {
      const st = enrollCheckFlow.get(sessionId);

      if (st.step === "nombre") {
        const nombre = userMessage.trim();
        if (!nombre || nombre.length < 3) {
          const reply = "Escribe tu NOMBRE y APELLIDO (mínimo 3 caracteres).";
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        let rows = [];
        try {
          rows = (await getEnrollmentsByName(nombre)) || [];
        } catch {
          const reply = "Lo siento, no pude consultar tu inscripción en este momento. Intenta más tarde.";
          enrollCheckFlow.delete(sessionId);
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
        }

        if (!rows.length) {
          const reply = `No encuentro una inscripción con el nombre: ${nombre}.

Si quieres inscribirte ahora escribe: INSCRIBIRME`;
          enrollCheckFlow.delete(sessionId);
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
        }

        // muchas coincidencias -> pedir whatsapp
        if (rows.length > 1) {
          enrollCheckFlow.set(sessionId, { step: "whatsapp", nombre });
          const reply = `Encontré varias coincidencias con ese nombre.

Para confirmar, escribe tu número de WhatsApp (ej: +593991112233 o 0991112233).`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        const reply = formatEnrollmentsReply(nombre, rows);
        enrollCheckFlow.delete(sessionId);

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
      }

      if (st.step === "whatsapp") {
        const w = extractWhatsapp(userMessage);
        if (!w) {
          const reply = "No pude leer el número 😅 Escríbelo así: +593991112233 o 0991112233";
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        let rows = [];
        try {
          rows = (await getEnrollmentsByWhatsAppAndName(w, st.nombre)) || [];
        } catch {
          const reply = "Lo siento, no pude consultar tu inscripción en este momento. Intenta más tarde.";
          enrollCheckFlow.delete(sessionId);
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
        }

        if (!rows.length) {
          const reply = `No encontré una inscripción que coincida con ese WhatsApp.

Si deseas inscribirte ahora escribe: INSCRIBIRME`;
          enrollCheckFlow.delete(sessionId);
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
        }

        const reply = formatEnrollmentsReply(st.nombre, rows);
        enrollCheckFlow.delete(sessionId);

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
      }
    }

    // ====== disparador: “ya estoy inscrito” ======
    if (isEnrollmentStatusQuery(userMessage)) {
      resetFlows(sessionId);
      enrollCheckFlow.set(sessionId, { step: "nombre" });

      const reply = "✅ Claro. Para verificarlo, dime tu NOMBRE y APELLIDO (tal como lo registraste).";
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
    }

    // ====== info fundación ======
    if (isBenefitsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = beneficiosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isWorkWithUsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = trabajarConNosotrosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isScholarshipQuery(userMessage)) {
      resetFlows(sessionId);
      scholarshipIntent.set(sessionId, true);
      const reply = becasTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsBecas() }, 200);
    }

    if (isCourseDifferenceQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = diferenciaCursosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsDifference() }, 200);
    }

    if (isSetecQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = setecTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isApprovalCriteriaQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = aprobacionCursosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isLearningResourcesQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = recursosCursoTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
    }

    if (isModalitiesQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = modalidadesTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsEnrollmentMode() }, 200);
    }

    if (isCorporateGroupsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = empresasTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isInstructorQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = instructorTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isStoreQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = tiendaSolidariaTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsStore() }, 200);
    }

    if (isHistoryHelpQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = historialTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isTodayDateQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = await buildEcuadorNowReplyWithAI(userMessage, "date");
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isCurrentTimeQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = await buildEcuadorNowReplyWithAI(userMessage, "time");
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isFutureCoursesQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = cursosFuturosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isAllCoursesQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = todosLosCursosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsDifference() }, 200);
    }

    if (isFounderQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = fundadoraTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isTestimonialsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = testimoniosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isCourseSuggestionQuery(userMessage)) {
      resetFlows(sessionId);
      advisorFlow.set(sessionId, { step: "persona", persona: "", interes: "", tiempo: "", mode: scholarshipIntent.get(sessionId) ? "beca" : "" });
      const reply = `TEST DE AYUDA (3 preguntas)

1/3) Cual te describe mejor?
- Docente
- Padre/Madre
- Estudiante
- Profesional`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorStart() }, 200);
    }

    if (isClassTimeQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = horariosConsultaTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsHorariosMenu() }, 200);
    }

    if (isClassStartQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = inicioClasesTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
    }

    if (isPasswordRecoveryQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = recuperarContrasenaTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isAccountRegistrationQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = crearCuentaTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isMissionQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = misionTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isVisionQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = visionTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isValuesQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = valoresTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isPillarsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = pilaresTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isAboutUsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = quienesSomosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    if (isAffirmation(userMessage)) {
      const reply = `Perfecto. Si deseas, puedes seguir preguntándome y con gusto te ayudo.

Si quieres ver el menú principal, escribe: MENU`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isCertificarmeQuery(userMessage)) {
      resetFlows(sessionId);
      certificarmeFlow.set(sessionId, { step: "choose_course" });

      const reply = certificarmeIntroTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCertificarmeCursos() }, 200);
    }

    // ====== menú numérico ======
    if (/^[1-6]$/.test(t)) {
      resetFlows(sessionId);

      if (t === "1") {
        courseContext.set(sessionId, "free");
        const reply = cursosGratisTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
      }

      if (t === "2") {
        courseContext.set(sessionId, "cert");
        const reply = cursosCertTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
      }

      if (t === "3") {
        const reply = contactoTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
      }

      if (t === "4") {
        const reply = donarTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
      }

      if (t === "5") {
        certFlow.set(sessionId, { step: "order", orderNumber: "" });
        const reply = certAskText();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
      }

      if (t === "6") {
        scheduleFlow.set(sessionId, { step: "modalidad", data: {} });
        const reply = horariosTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowMode() }, 200);
      }
    }

    // ====== test de ayuda (3 preguntas) ======
    if (isAdvisorTestIntentQuery(userMessage)) {
      resetFlows(sessionId);
      advisorFlow.set(sessionId, { step: "persona", persona: "", interes: "", tiempo: "", mode: scholarshipIntent.get(sessionId) ? "beca" : "" });

      const reply = `TEST DE AYUDA (3 preguntas)

1/3) Cual te describe mejor?
- Docente
- Padre/Madre
- Estudiante
- Profesional`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorStart() }, 200);
    }

    // ====== asesor humano (WhatsApp directo) ======
    if (isHumanAdvisorRequest(userMessage) || t.includes("asesor")) {
      resetFlows(sessionId);
      const waLink = getWhatsAppLink();
      const reply = waLink
        ? `Esta bien, te voy a enviar un asesor por via WhatsApp.

Toca este enlace para abrir WhatsApp:
${waLink}`
        : `Esta bien, te voy a enviar un asesor por via WhatsApp.

Escribenos al ${CONTACT_PHONE_1}.`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    // ====== asesor ======
    if (t.includes("recomendar") || t.includes("recomendacion") || t.includes("recomendaci��n")) {
      resetFlows(sessionId);
      advisorFlow.set(sessionId, { step: "persona", persona: "", interes: "", tiempo: "", mode: scholarshipIntent.get(sessionId) ? "beca" : "" });

      const reply = `TEST DE AYUDA (3 preguntas)\n\n1/3) Cual te describe mejor?\n- Docente\n- Padre/Madre\n- Estudiante\n- Profesional`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorStart() }, 200);
    }

    // contexto por palabras
    if (t.includes("gratis") || t.includes("gratuito")) courseContext.set(sessionId, "free");
    if (t.includes("precio") || t.includes("costo") || t.includes("con certificado") || t.includes("pago")) courseContext.set(sessionId, "cert");

    // ====== inscripción (A-Z + letras, sin bug) ======
    if (t.includes("inscrib") || t.includes("inscripcion") || t.includes("inscripción")) {
      resetFlows(sessionId);
      scholarshipIntent.delete(sessionId);

      // ✅ CLAVE: si es "inscribirme" general, usa courseContext si existe
      const wantsFree = t.includes("gratis") || t.includes("gratuito");
      const wantsCert = t.includes("cert") || t.includes("precio") || t.includes("costo") || t.includes("pago") || t.includes("con certificado");

      const schedIdPrev = scheduleJustSaved.get(sessionId) ? lastSchedulePrefId.get(sessionId) || null : null;
      if (scheduleJustSaved.has(sessionId)) scheduleJustSaved.delete(sessionId);
      const ctxType = courseContext.get(sessionId);
      const type =
        wantsFree ? "free" : wantsCert ? "cert" : schedIdPrev ? "all" : ctxType === "free" || ctxType === "cert" ? ctxType : "all";

      const cached = profileCache.get(sessionId);
      const hasProfile =
        cached &&
        cached.nombre &&
        cached.whatsapp &&
        cached.email &&
        cached.cedula;

      if (hasProfile) {
        const modalidad = cached.modalidad === "virtual" ? "online" : cached.modalidad || "";
        const sede = modalidad === "presencial" ? PRESENTIAL_SEDE : "";
        const pick = buildCoursePicker(type, { availableOnly: false });

        leadFlow.set(sessionId, {
          step: "choose_course",
          data: {
            nombre: cached.nombre,
            whatsapp: cached.whatsapp,
            email: cached.email,
            cedula: cached.cedula,
            curso: "",
            modalidad,
            sede,
            schedule_pref_id: cached.schedule_pref_id || schedIdPrev,
            course_type: type,
            franja: cached.franja || "",
            dias: cached.dias || "",
            course_map: pick.map,
            skip_schedule: true,
            skip_profile: true,
          },
        });

        const title =
          type === "free"
            ? "📝 INSCRIPCIÓN (CURSOS GRATIS A-Z)"
            : type === "cert"
            ? "📝 INSCRIPCIÓN (CURSOS CON CERTIFICADO A-Z)"
            : "📝 INSCRIPCIÓN (CURSOS A-Z)";

        const sedeLine = modalidad === "presencial" ? `\nSede: ${sede}` : "";
        const reply = `${title}

Modalidad: ${String(modalidad || "online").toUpperCase()}${sedeLine}

Elige el curso (responde con la letra):

${pick.lines.join("\n")}`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: pick.suggestions }, 200);
      }

      leadFlow.set(sessionId, {
        step: "choose_modality",
        data: {
          nombre: "",
          whatsapp: "",
          email: "",
          cedula: "",
          curso: "",
          modalidad: "",
          sede: "",
          schedule_pref_id: schedIdPrev,
          course_type: type,
          franja: "",
          dias: "",
          course_map: {},
          skip_schedule: !!schedIdPrev,
          skip_profile: false,
        },
      });

      const reply = `📝 INSCRIPCIÓN

Paso 1) Elige la modalidad:
- Presencial
- Online`;

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }

      return sendJson(res, { reply, sessionId, suggestions: suggestionsEnrollmentMode() }, 200);
    }

    // ====== accesos directos ======
    if (t.includes("horario")) {
      resetFlows(sessionId);
      scheduleFlow.set(sessionId, { step: "modalidad", data: {} });
      const reply = horariosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowMode() }, 200);
    }

    if (t.includes("donaci") || t.includes("donar")) {
      const reply = donarTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (isWhatsAppNumberQuery(userMessage)) {
      const reply = whatsappInfoTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (t.includes("contact") || t.includes("whatsapp") || t.includes("correo")) {
      const reply = contactoTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
    }

    if (t.includes("gratis") || t.includes("gratuito")) {
      courseContext.set(sessionId, "free");
      const reply = cursosGratisTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
    }

    if (t.includes("precio") || t.includes("costo") || (t.includes("curso") && (t.includes("pago") || t.includes("con certificado")))) {
      courseContext.set(sessionId, "cert");
      const reply = cursosCertTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCourseLists() }, 200);
    }

    // ====== FLUJO CERTIFICARME (SIN IA) ======
    if (certificarmeFlow.has(sessionId)) {
      const st = certificarmeFlow.get(sessionId);

      if (st.step === "choose_course") {
        const cursoElegido = userMessage.trim();

        const norm = normalizeText(cursoElegido);
        const opciones = CERT_COURSES.map((c) => c.name);
        const matchObj =
          CERT_COURSES.find((c) => normalizeText(c.name) === norm) ||
          CERT_COURSES.find((c) => normalizeText(c.label) === norm) ||
          CERT_COURSES.find((c) => norm.includes(normalizeText(c.name)));
        const match = matchObj ? matchObj.name : opciones.find((o) => normalizeText(o) === norm);
        if (!match) {
          const reply = "Por favor selecciona un curso de la lista para continuar.";
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCertificarmeCursos() }, 200);
        }

        certificarmeFlow.delete(sessionId);

        leadFlow.set(sessionId, {
          step: "choose_modality",
          data: {
            nombre: "",
            whatsapp: "",
            email: "",
            cedula: "",
            curso: match,
            modalidad: "",
            sede: "",
            schedule_after_whatsapp: true,
            course_type: "cert",
            franja: "",
            dias: "",
            course_map: {},
            skip_schedule: false,
            schedule_pref_id: null,
          },
        });

        const reply = `✅ Perfecto. Para certificarte en:
🎓 ${match}

Paso 1) Elige la modalidad:
- Presencial
- Online`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(res, { reply, sessionId, suggestions: suggestionsEnrollmentMode() }, 200);
      }
    }

    // ====== FLUJO CERTIFICADO (estado) ======
    if (certFlow.has(sessionId)) {
      const st = certFlow.get(sessionId);
      const raw = String(userMessage || "").trim();
      const digits = raw.replace(/\D/g, "");

      const onlyFourDigitsMessage = `Por favor ingresa SOLO 4 DÍGITOS del número de pedido.
Ejemplo: 9039
(Para salir: MENU)`;
      const askCourseMessage = (orderNumber) => `Número de pedido recibido (${orderNumber})

Ahora escribe el NOMBRE DEL CURSO.
Ejemplo: Inteligencia Emocional
(Para salir: MENU)`;
      const invalidCourseMessage = `Por favor escribe el NOMBRE DEL CURSO (solo texto).
Ejemplo: Inteligencia Emocional
(Para salir: MENU)`;

      if (st.step === "order") {
        if (digits.length !== 4) {
          const reply = onlyFourDigitsMessage;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
        }

        const orderNumber = digits;
        const cursoMaybe = extractCourse(raw, orderNumber);
        const cursoNorm = normalizeText(cursoMaybe);

        if (!cursoNorm || cursoNorm.length < 3) {
          st.step = "course";
          st.orderNumber = orderNumber;
          certFlow.set(sessionId, st);

          const reply = askCourseMessage(orderNumber);
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
        }

        let reply;
        try {
          const row = await getCertificateStatus(orderNumber, cursoMaybe);
          if (!row) {
            reply = `No encuentro un registro para:
- Numero de pedido: ${orderNumber}
- Curso: ${cursoMaybe}

Si crees que es un error, contactanos:
${CONTACT_PHONE_1}
${CONTACT_PHONE_2}
${CONTACT_EMAIL}`;
          } else {
            reply = certificateReplyFromRow(row);
          }
        } catch {
          reply = `Lo siento, no pude consultar el estado en este momento.
Intenta más tarde.`;
        }

        certFlow.delete(sessionId);

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
      }

      if (st.step === "course") {
        if (digits.length > 0) {
          const reply = invalidCourseMessage;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
        }

        const curso = extractCourse(raw, "");
        if (!curso || curso.length < 3) {
          const reply = invalidCourseMessage;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
        }

        let reply;
        try {
          const row = await getCertificateStatus(st.orderNumber, curso);
          if (!row) {
            reply = `No encuentro un registro para:
- Numero de pedido: ${st.orderNumber}
- Curso: ${curso}

Si crees que es un error, contactanos:
${CONTACT_PHONE_1}
${CONTACT_PHONE_2}
${CONTACT_EMAIL}`;
          } else {
            reply = certificateReplyFromRow(row);
          }
        } catch {
          reply = `Lo siento, no pude consultar el estado en este momento.
Intenta más tarde.`;
        }

        certFlow.delete(sessionId);

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
      }
    }

    // ====== FLUJO ASESOR (SIN IA) con validación ======
    if (advisorFlow.has(sessionId)) {
      const st = advisorFlow.get(sessionId);

      if (st.step === "persona") {
        const p = normalizeText(userMessage);
        const ok = ["docente", "padre", "madre", "estudiante", "profesional"].some((x) => p.includes(x));
        if (!ok) {
          const reply = `Elige una opción válida:
- Docente
- Padre/Madre
- Estudiante
- Profesional`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorStart() }, 200);
        }

        st.persona = userMessage.trim();
        st.step = "interes";
        advisorFlow.set(sessionId, st);

        const reply = `2/3) ¿Qué buscas principalmente?

- Habilidades blandas
- Tecnología
- Educación`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorInterest() }, 200);
      }

      if (st.step === "interes") {
        const i = normalizeText(userMessage);
        const ok = i.includes("habilidades") || i.includes("blandas") || i.includes("tecnolog") || i.includes("educa");
        if (!ok) {
          const reply = `Elige una opción válida:
- Habilidades blandas
- Tecnología
- Educación`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorInterest() }, 200);
        }

        st.interes = userMessage.trim();
        st.step = "tiempo";
        advisorFlow.set(sessionId, st);

        const reply = `3/3) ¿Cuánto tiempo tienes a la semana?

- 1-2
- 3-5
- 5+`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorTime() }, 200);
      }

      if (st.step === "tiempo") {
        const tt = normalizeText(userMessage);
        const ok = ["1-2", "3-5", "5+"].includes(tt); // ✅ ahora sí funciona "5+"
        if (!ok) {
          const reply = `Elige una opción válida:
- 1-2
- 3-5
- 5+`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorTime() }, 200);
        }

        st.tiempo = userMessage.trim();
        advisorFlow.delete(sessionId);
        courseContext.delete(sessionId);

        const rec = recommendCourse(st);
        const isScholarshipMode = st.mode === "beca" || scholarshipIntent.get(sessionId) === true;

        const reply = isScholarshipMode
          ? `✅ RECOMENDACION PERSONALIZADA PARA BECA

Segun lo que me dijiste, te recomiendo:
🎯 ${rec.curso}

Motivo: ${rec.motivo}

Como es proceso de BECA, no necesitas inscribirte ahora por aqui.
Envia tu solicitud de beca al correo: ${CONTACT_EMAIL}

Incluye:
1) Nombres completos
2) WhatsApp
3) Curso recomendado
4) Motivo de la solicitud y situacion actual`
          : `✅ RECOMENDACIÓN PERSONALIZADA

Según lo que me dijiste, te recomiendo:
🎯 ${rec.curso}

Motivo: ${rec.motivo}

Si quieres, te ayudo a inscribirte:
Escribe: INSCRIBIRME`;

        scholarshipIntent.delete(sessionId);
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(
          res,
          { reply, sessionId, suggestions: isScholarshipMode ? suggestionsOnlyMenu() : suggestionsCourseLists() },
          200
        );
      }
    }

    // ====== FLUJO INSCRIPCIÓN (con cursos + horarios) ======
    if (leadFlow.has(sessionId)) {
      const st = leadFlow.get(sessionId);

      if (st.step === "choose_modality") {
        const m = normalizeText(userMessage);
        const isPresencial = m.includes("presencial");
        const isOnline = m === "online" || m.includes("en linea") || m.includes("virtual");

        if (!isPresencial && !isOnline) {
          const reply = `Selecciona una modalidad válida:
- Presencial
- Online`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsEnrollmentMode() }, 200);
        }

        st.data.modalidad = isPresencial ? "presencial" : "online";
        st.data.sede = isPresencial ? PRESENTIAL_SEDE : "";

        // Si el curso ya viene preseleccionado (flujo certificarme), sigue con datos
        if (st.data.curso) {
          st.step = "nombre";
          leadFlow.set(sessionId, st);

          const sedeLine = st.data.modalidad === "presencial" ? `\nSede: ${st.data.sede}` : "";
          const reply = `✅ Modalidad: ${st.data.modalidad.toUpperCase()}${sedeLine}
Curso: ${st.data.curso}

Ahora dime tu NOMBRE (nombre y apellido).`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        const type = st.data.course_type;
        const pick = buildCoursePicker(type, { availableOnly: false });
        st.data.course_map = pick.map;
        st.step = "choose_course";
        leadFlow.set(sessionId, st);

        const title =
          type === "free"
            ? "📝 INSCRIPCIÓN (CURSOS GRATIS A-Z)"
            : type === "cert"
            ? "📝 INSCRIPCIÓN (CURSOS CON CERTIFICADO A-Z)"
            : "📝 INSCRIPCIÓN (CURSOS A-Z)";

        const sedeLine = st.data.modalidad === "presencial" ? `\nSede: ${st.data.sede}` : "";
        const reply = `${title}

Modalidad: ${st.data.modalidad.toUpperCase()}${sedeLine}

Paso 2) Elige el curso (responde con la letra):

${pick.lines.join("\n")}

Al final, parte del equipo de la Fundacion se contactara contigo.`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(res, { reply, sessionId, suggestions: pick.suggestions }, 200);
      }

      if (st.step === "choose_course") {
        const type = st.data.course_type;

        const pick = buildCoursePicker(type, { availableOnly: false });

        // 1) Elección por letra (A,B,C...)
        const key = extractAlphaChoice(userMessage);
        const byLetter = key ? st.data.course_map?.[key] || pick.map?.[key] || "" : "";

        // 2) Elección por nombre
        const input = normalizeText(userMessage);
        const byName =
          pick.list.find((c) => normalizeText(c.name) === input) ||
          pick.list.find((c) => input.includes(normalizeText(c.name)));

        const finalCourse = byLetter || (byName ? byName.name : "");

        if (!finalCourse) {
          const reply = `Por favor selecciona un curso válido (letra o nombre):

${pick.lines.join("\n")}`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: pick.suggestions }, 200);
        }

        st.data.curso = finalCourse;

        if (st.data.skip_profile) {
          try {
            const updated = await updateLeadCourseForSession(userKey, sessionId, st.data.curso);
            if (!updated) await saveLead(userKey, sessionId, st.data);
          } catch (e) {
            console.warn("⚠️ No se pudo guardar lead:", extractMessage(e));
          }

          leadFlow.delete(sessionId);

          const sedeInfo = st.data.modalidad === "presencial" ? `\nSede: ${st.data.sede || PRESENTIAL_SEDE}` : "";
          const horarioInfo = st.data.franja && st.data.dias ? `\nHorario: ${st.data.franja} | ${st.data.dias}` : "";
          const reply = `✅ ¡Listo! Tu preinscripción fue registrada.

Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}
Correo: ${st.data.email}
Cédula: ${maskCedula(st.data.cedula)}
Modalidad: ${String(st.data.modalidad || "online").toUpperCase()}${sedeInfo}${horarioInfo}
Curso: ${st.data.curso}

Parte del equipo de la Fundación se contactará contigo por WhatsApp para continuar con la inscripción oficial.
En ese contacto te compartirán el proceso para crear tu cuenta en la página y finalizar tu matrícula.
Si quieres ver opciones: escribe MENU`;

          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
        }

        if (st.data.skip_schedule) {
          st.step = "nombre";
          leadFlow.set(sessionId, st);

          const reply = `✅ Perfecto. Ya tengo tu horario guardado.

Modalidad: ${st.data.modalidad.toUpperCase()}
Curso: ${st.data.curso}

Ahora dime tu NOMBRE (nombre y apellido).`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.step = "franja";
        leadFlow.set(sessionId, st);

        const reply = `Paso 3) 🕒 Elige tu preferencia de horario:
- Mañana
- Tarde
- Noche`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
      }

      if (st.step === "franja") {
        const v = normalizeText(userMessage);
        const ok = ["manana", "tarde", "noche"].includes(v);
        if (!ok) {
          const reply = `Dime tu preferencia escribiendo:
- Mañana
- Tarde
- Noche
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
        }

        st.data.franja = v;
        st.step = "dias";
        leadFlow.set(sessionId, st);

        const reply = `Paso 4) 📅 ¿En qué días se te facilita más?
- Lun-Vie
- Sábado y Domingo`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
      }

      if (st.step === "dias") {
        const d = normalizeText(userMessage);
        const ok = d === "lun-vie" || (d.includes("sabado") && d.includes("domingo"));
        if (!ok) {
          const reply = `Selecciona una opción:
- Lun-Vie
- Sábado y Domingo
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
        }

        st.data.dias = d === "lun-vie" ? "lun-vie" : "sabado y domingo";

        let schedId = null;
        try {
          const out = await saveSchedule(userKey, sessionId, { franja: st.data.franja, dias: st.data.dias });
          schedId = out?.id ?? null;
          if (schedId) {
            st.data.schedule_pref_id = schedId;
            lastSchedulePrefId.set(sessionId, schedId);
          }
        } catch (e) {
          console.warn("⚠️ No se pudo guardar horario:", extractMessage(e));
        }

        st.step = "nombre";
        leadFlow.set(sessionId, st);

        const reply = `Paso 5) ✅ Perfecto.

Modalidad: ${st.data.modalidad.toUpperCase()}
Curso: ${st.data.curso}
Horario: ${st.data.franja} | ${st.data.dias}

Ahora dime tu NOMBRE y APELLIDO (solo letras).
Ejemplo: Maria Perez`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "nombre") {
        const nombreInput = userMessage.trim();
        if (!isValidFullName(nombreInput)) {
          const reply = `Por favor escribe tu NOMBRE Y APELLIDO de forma correcta.
- Solo letras (sin números)
- Mínimo nombre y apellido
Ejemplo válido: Maria Perez
Ejemplo no válido: Maria123
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.nombre = nombreInput;
        st.step = "whatsapp";
        leadFlow.set(sessionId, st);

        const reply = `✅ Gracias, ${st.data.nombre}.

Ahora escribe tu número de WhatsApp.
Formato válido:
0991112233
+593991112233`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "whatsapp") {
        if (!isStrictEcuadorWhatsApp(userMessage)) {
          const reply = `Por favor escribe tu WhatsApp en un formato válido.
Ejemplos válidos:
0991112233
+593991112233
Ejemplo no válido:
991112233
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.whatsapp = normalizeEcuadorWhatsApp(userMessage);
        st.step = "email";
        leadFlow.set(sessionId, st);

        const reply = `✅ Perfecto.

Ahora escribe tu correo electrónico.
Ejemplo válido: nombre@correo.com
Ejemplo no válido: nombre@correo`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "email") {
        if (!isValidEmail(userMessage)) {
          const reply = `Por favor escribe un correo electrónico válido.
Ejemplo válido: nombre@correo.com
Ejemplo no válido: nombre@correo
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.email = extractEmail(userMessage);
        st.step = "cedula";
        leadFlow.set(sessionId, st);

        const reply = `✅ Correo registrado.

Ahora escribe tu número de cédula (10 dígitos).
Ejemplo: 0912345678`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "cedula") {
        if (!isValidCedula(userMessage)) {
          const reply = `Por favor escribe una cédula válida.
- Debe tener 10 dígitos
Ejemplo: 0912345678
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.cedula = extractCedula(userMessage);

        if (st.data.schedule_after_whatsapp) {
          st.step = "franja_after_whatsapp";
          leadFlow.set(sessionId, st);

          const reply = `Elige tu preferencia de horario:
- Mañana
- Tarde
- Noche`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
        }

        try {
          await saveLead(userKey, sessionId, st.data);
        } catch (e) {
          console.warn("⚠️ No se pudo guardar lead:", extractMessage(e));
        }

        leadFlow.delete(sessionId);

        const extra = st.data.schedule_pref_id ? `\nHorario vinculado (ID): ${st.data.schedule_pref_id}` : "";
        const sedeInfo = st.data.modalidad === "presencial" ? `\nSede: ${st.data.sede || PRESENTIAL_SEDE}` : "";
        const horarioInfo = st.data.franja && st.data.dias ? `\nHorario: ${st.data.franja} | ${st.data.dias}` : "";
        const reply = `✅ ¡Listo! Tu preinscripción fue registrada.

Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}
Correo: ${st.data.email}
Cédula: ${maskCedula(st.data.cedula)}
Modalidad: ${String(st.data.modalidad || "online").toUpperCase()}${sedeInfo}${horarioInfo}
Curso: ${st.data.curso}${extra}

Parte del equipo de la Fundación se contactará contigo por WhatsApp para continuar con la inscripción oficial.
En ese contacto te compartirán el proceso para crear tu cuenta en la página y finalizar tu matrícula.
Si quieres ver opciones: escribe MENU`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
      }

      if (st.step === "franja_after_whatsapp") {
        const v = normalizeText(userMessage);
        const ok = ["manana", "tarde", "noche"].includes(v);
        if (!ok) {
          const reply = `Dime tu preferencia escribiendo:
- Manana
- Tarde
- Noche
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
        }

        st.data.franja = v;
        st.step = "dias_after_whatsapp";
        leadFlow.set(sessionId, st);

        const reply = `En que dias se te facilita mas?
- Lun-Vie
- Sabado y Domingo`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
      }

      if (st.step === "dias_after_whatsapp") {
        const d = normalizeText(userMessage);
        const ok = d === "lun-vie" || (d.includes("sabado") && d.includes("domingo"));
        if (!ok) {
          const reply = `Selecciona una opcion:
- Lun-Vie
- Sabado y Domingo
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
        }

        st.data.dias = d === "lun-vie" ? "lun-vie" : "sabado y domingo";

        try {
          const out = await saveSchedule(userKey, sessionId, { franja: st.data.franja, dias: st.data.dias });
          const schedId = out?.id ?? null;
          if (schedId) {
            st.data.schedule_pref_id = schedId;
            lastSchedulePrefId.set(sessionId, schedId);
          }
        } catch (e) {
          console.warn("⚠️ No se pudo guardar horario:", extractMessage(e));
        }

        try {
          await saveLead(userKey, sessionId, st.data);
        } catch (e) {
          console.warn("⚠️ No se pudo guardar lead:", extractMessage(e));
        }

        leadFlow.delete(sessionId);

        const extra = st.data.schedule_pref_id ? `\nHorario vinculado (ID): ${st.data.schedule_pref_id}` : "";
        const sedeInfo = st.data.modalidad === "presencial" ? `\nSede: ${st.data.sede || PRESENTIAL_SEDE}` : "";
        const horarioInfo = st.data.franja && st.data.dias ? `\nHorario: ${st.data.franja} | ${st.data.dias}` : "";
        const reply = `✅ Listo! Tu preinscripción fue registrada.

Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}
Correo: ${st.data.email}
Cédula: ${maskCedula(st.data.cedula)}
Modalidad: ${String(st.data.modalidad || "online").toUpperCase()}${sedeInfo}${horarioInfo}
Curso: ${st.data.curso}${extra}

Parte del equipo de la Fundación se contactará contigo por WhatsApp para continuar con la inscripción oficial.
En ese contacto te compartirán el proceso para crear tu cuenta en la página y finalizar tu matrícula.
Si quieres ver opciones: escribe MENU`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsOnlyMenu() }, 200);
      }
    }

    // ====== FLUJO HORARIO (opción 6) con validación de días ======
    if (scheduleFlow.has(sessionId)) {
      const st = scheduleFlow.get(sessionId);

      if (st.step === "modalidad") {
        const v = normalizeText(userMessage);
        const isPresencial = v.includes("presencial");
        const isVirtual = v.includes("virtual") || v.includes("online");
        if (!isPresencial && !isVirtual) {
          const reply = `Elige tu modalidad:
- Presencial
- Virtual
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowMode() }, 200);
        }

        st.data.modalidad = isPresencial ? "presencial" : "virtual";
        st.data.sede = isPresencial ? PRESENTIAL_SEDE : "";
        st.step = "nombre";
        scheduleFlow.set(sessionId, st);

        const sedeLine = st.data.modalidad === "presencial" ? `\nSede: ${st.data.sede}` : "";
        const reply = `✅ Modalidad: ${st.data.modalidad.toUpperCase()}${sedeLine}.

Ahora dime tu NOMBRE y APELLIDO (solo letras).
Ejemplo: Maria Perez`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "nombre") {
        const nombreInput = userMessage.trim();
        if (!isValidFullName(nombreInput)) {
          const reply = `Por favor escribe tu NOMBRE Y APELLIDO de forma correcta.
- Solo letras (sin números)
- Mínimo nombre y apellido
Ejemplo válido: Maria Perez
Ejemplo no válido: Maria123
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.nombre = nombreInput;
        st.step = "cedula";
        scheduleFlow.set(sessionId, st);

        const reply = `✅ Gracias, ${st.data.nombre}.

Ahora escribe tu número de cédula (10 dígitos).
Ejemplo: 0912345678`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "cedula") {
        if (!isValidCedula(userMessage)) {
          const reply = `Por favor escribe una cédula válida.
- Debe tener 10 dígitos
Ejemplo: 0912345678
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.cedula = extractCedula(userMessage);
        st.step = "whatsapp";
        scheduleFlow.set(sessionId, st);

        const reply = `✅ Cédula registrada.

Ahora escribe tu número de WhatsApp.
Formato válido:
0991112233
+593991112233`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "whatsapp") {
        if (!isValidEcuadorWhatsApp(userMessage)) {
          const reply = `Por favor escribe tu WhatsApp en un formato válido.
Ejemplos válidos:
0991112233
+593991112233
Ejemplo no válido:
991112233
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.whatsapp = normalizeEcuadorWhatsApp(userMessage);
        st.step = "email";
        scheduleFlow.set(sessionId, st);

        const reply = `✅ Perfecto.

Ahora escribe tu correo electrónico.
Ejemplo válido: nombre@correo.com
Ejemplo no válido: nombre@correo`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "email") {
        if (!isValidEmail(userMessage)) {
          const reply = `Por favor escribe un correo electrónico válido.
Ejemplo válido: nombre@correo.com
Ejemplo no válido: nombre@correo
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.email = extractEmail(userMessage);
        st.step = "franja";
        scheduleFlow.set(sessionId, st);

        const reply = `✅ Correo registrado.

Ahora dime tu preferencia de horario:
- Mañana
- Tarde
- Noche
(Si necesitas, también puedes escribir tu horario personalizado)`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
      }

      if (st.step === "franja") {
        const v = normalizeText(userMessage);
        const ok = ["manana", "tarde", "noche"].includes(v);
        if (!ok) {
          const custom = String(userMessage || "").trim();
          if (!custom || custom.length < 3) {
            const reply = `Dime tu preferencia escribiendo:
- Mañana
- Tarde
- Noche
O escribe tu horario personalizado
(Para salir: MENU)`;
            if (supabase) {
              await insertChatMessage(sessionId, userKey, "bot", reply);
              await touchSessionLastMessage(sessionId, userKey, reply);
            }
            return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
          }
          st.data.franja = custom;
        } else {
          st.data.franja = v;
        }
        st.step = "dias";
        scheduleFlow.set(sessionId, st);

        const label = ok ? v.toUpperCase() : st.data.franja;
        const reply = `✅ Anotado: ${label}.

¿En qué días se te facilita más?
- Lun-Vie
- Sábado y Domingo`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
      }

      if (st.step === "dias") {
        const d = normalizeText(userMessage);
        const ok = d === "lun-vie" || (d.includes("sabado") && d.includes("domingo"));
        if (!ok) {
          const reply = `Selecciona una opción:
- Lun-Vie
- Sábado y Domingo
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
        }

        st.data.dias = d === "lun-vie" ? "lun-vie" : "sabado y domingo";

        let saved = true;
        try {
          const out = await saveSchedule(userKey, sessionId, st.data);
          const schedId = out?.id ?? null;
          if (schedId) {
            lastSchedulePrefId.set(sessionId, schedId);
            scheduleJustSaved.set(sessionId, true);
            st.data.schedule_pref_id = schedId;
          }
        } catch (e) {
          saved = false;
          console.warn("⚠️ No se pudo guardar horario:", extractMessage(e));
        }

        scheduleFlow.delete(sessionId);
        courseContext.delete(sessionId);

        if (saved) {
          profileCache.set(sessionId, {
            nombre: st.data.nombre,
            cedula: st.data.cedula,
            whatsapp: st.data.whatsapp,
            email: st.data.email,
            modalidad: st.data.modalidad,
            sede: st.data.sede,
            franja: st.data.franja,
            dias: st.data.dias,
            schedule_pref_id: st.data.schedule_pref_id || null,
          });
          try {
            await saveLeadDraft(userKey, sessionId, st.data);
          } catch (e) {
            console.warn("⚠️ No se pudo guardar lead (borrador):", extractMessage(e));
          }
        }

        const reply = saved
          ? `✅ ¡Listo! Tu horario quedó registrado.

Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}
Correo: ${st.data.email}
Cédula: ${maskCedula(st.data.cedula)}
Modalidad: ${String(st.data.modalidad || "virtual").toUpperCase()}
Horario: ${st.data.franja} | ${st.data.dias}

¿Deseas inscribirte a un curso ahora o necesitas ayuda para elegir?
Puedes tocar INSCRIBIRME o TEST DE AYUDA.`
          : `✅ Preferencia recibida (pero OJO: no se pudo guardar en la BD todavía).

Franja: ${st.data.franja}
Días: ${st.data.dias}

Revisa que en Render estén SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(res, { reply, sessionId, suggestions: saved ? suggestionsAfterScheduleSaved() : suggestionsMenu() }, 200);
      }
    }

    // ====== si es tema fundación, guiamos ======
    if (isFoundationQuery(userMessage)) {
      const reply = `Puedo ayudarte con información de la Fundación Capacítamente.

Escribe:
- MENU (ver opciones)
- QUIENES SOMOS
- MISION
- VISION
- VALORES
- PILARES
- FUNDADORA
- TESTIMONIOS
- BECAS
- SETEC
- TIENDA SOLIDARIA
- BENEFICIOS
- CERTIFICARME
- TRABAJA CON NOSOTROS`;

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }

      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    // ====== fallback guiado ANTES de IA ======
    const guided = buildGuidedFallbackForFoundation(userMessage);
    if (guided) {
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", guided.reply);
        await touchSessionLastMessage(sessionId, userKey, guided.reply);
      }
      return sendJson(res, { reply: guided.reply, sessionId, suggestions: guided.suggestions }, 200);
    }

    // ============================
    // IA
    // ============================
    if (!ai) {
      const msg = "Ahora mismo solo puedo ayudarte con el menú e información de la Fundación. Escribe MENU para ver opciones.";
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return sendJson(res, { reply: msg, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    if (!canUseAI(userKey)) {
      const msg = aiFallbackMenuText();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return sendJson(res, { reply: msg, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    if (AI_COOLDOWN_MS > 0) {
      const last = aiLastCallAt.get(sessionId) || 0;
      const now = Date.now();
      if (now - last < AI_COOLDOWN_MS) {
        const msg = aiFallbackMenuText();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", msg);
          await touchSessionLastMessage(sessionId, userKey, msg);
        }
        return sendJson(res, { reply: msg, sessionId, suggestions: suggestionsMenu() }, 200);
      }
      aiLastCallAt.set(sessionId, now);
    }

    let sessionObj = sessions.get(sessionId);
    if (!sessionObj) {
      const chat = ai.chats.create({
        model: GEMINI_MODEL,
        config: {
          systemInstruction,
          temperature: GEMINI_TEMPERATURE,
          maxOutputTokens: GEMINI_MAX_TOKENS,
        },
      });
      sessionObj = { chat, lastAccess: Date.now() };
      sessions.set(sessionId, sessionObj);
      console.log("🆕 Nueva sesión IA:", sessionId);
    } else {
      sessionObj.lastAccess = Date.now();
    }

    incAI(userKey);

    const response = await geminiSendWithRetry(sessionObj, userMessage);

    let reply = typeof response?.text === "string" ? response.text.trim() : "";
    reply = reply.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

    if (!reply) {
      const msg = aiFallbackMenuText();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return sendJson(res, { reply: msg, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    reply = `${reply}\n\nSi deseas, puedes seguir preguntándome y con gusto te ayudo. Si prefieres ver el menú principal, escribe: MENU.`;

    if (supabase) {
      await insertChatMessage(sessionId, userKey, "bot", reply);
      await touchSessionLastMessage(sessionId, userKey, reply);
    }

    return sendJson(res, { reply, sessionId, suggestions: [] }, 200);
  } catch (error) {
    const status = extractStatus(error);
    const msg = extractMessage(error);
    console.error("❌ Error /chat:", msg);

    if (status === 403) {
      return sendJson(res, { reply: "Esta conversación no te pertenece. Crea una nueva (botón Nueva).", sessionId: "" }, 403);
    }

    if (status === 429 || status === 503 || /RESOURCE_EXHAUSTED|quota|rate limit|429|overloaded|NO DISPONIBLE/i.test(msg)) {
      const reply = aiFallbackMenuText();
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    const reply = aiFallbackMenuText();
    return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
  }
});

// ============================
// Errores globales
// ============================
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});

// Render envía SIGTERM cuando reinicia
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM recibido. Cerrando servidor...");
  process.exit(0);
});

if (require.main === module) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`✅ Servidor escuchando en puerto ${port}`);
    console.log(`🤖 Gemini: modelo=${GEMINI_MODEL} tokens=${GEMINI_MAX_TOKENS} temperatura=${GEMINI_TEMPERATURE}`);
    console.log(`⏱️ Cooldown(ms)=${AI_COOLDOWN_MS} | max diarios IA=${MAX_DAILY_AI_CALLS} | retries=${GEMINI_RETRIES}`);
    console.log(`🧯 RateLimit: max=${RATE_LIMIT_MAX}/ventana(${RATE_LIMIT_WINDOW_MS}ms) | maxMsg=${MAX_MESSAGE_CHARS} chars`);
  });
}

module.exports = {
  normalizeText,
  isScholarshipQuery,
  isCourseDifferenceQuery,
  isApprovalCriteriaQuery,
  isInstructorQuery,
  isStoreQuery,
  isAccountRegistrationQuery,
  buildGuidedFallbackForFoundation,
};

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
// CORS (IMPORTANTE: x-client-id)
// ============================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-client-id"],
  })
);
app.options("*", cors());
app.use(express.json({ strict: false, limit: "1mb" }));

// ============================
// IA (Gemini) - SOLO se usa si NO es tema Fundación
// ============================
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.warn(
    "⚠️ Falta GEMINI_API_KEY (o GOOGLE_API_KEY). El bot funcionará en modo Fundación/FAQ sin IA."
  );
}
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Variables que YA tienes en Render (las usamos)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE || 0.3);
const GEMINI_MAX_TOKENS = Number(process.env.GEMINI_MAX_TOKENS || 600);
const AI_COOLDOWN_MS = Number(process.env.AI_COOLDOWN_MS || 0);

// Reintentos contra "modelo ocupado"
const GEMINI_RETRIES = Math.max(0, Number(process.env.GEMINI_RETRIES || 2));
const GEMINI_RETRY_BASE_MS = Math.max(
  100,
  Number(process.env.GEMINI_RETRY_BASE_MS || 700)
);

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
  console.warn(
    "⚠️ Supabase NO configurada. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY."
  );
}

// ============================
// System instruction (IA)
// (La Fundación se responde SIN IA por reglas abajo)
// ============================
const systemInstruction = `
Eres Lyro-Capacítamente, un asistente virtual amable y servicial.
Responde de forma clara, completa y concisa. Si algo es ambiguo, pide un dato puntual.
`;

// ============================
// Helpers base
// ============================
function normalizeText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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
  return `session-${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")}`;
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
  if (/overloaded|temporarily|unavailable|try again|timeout/i.test(m))
    return true;
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
📱 0983222358
☎️ 046026948
✉️ info@fundacioncapacitamente.com`;
}

// ============================
// Textos Fundación (SIN IA)
// Fuente: https://fundacioncapacitamente.com/acerca-de/ y /contacto/
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

function cursosGratisTexto() {
  return `🎓 CURSOS GRATUITOS

• Tecnología para Educadores – Tatiana Arias

📌 Próximamente:
• Metodología de la Pregunta – Tatiana Arias
• Neuroeducación… También en casa – Prosandoval

Si quieres recomendación personalizada, escribe: ASESOR
Si quieres inscribirte, escribe: INSCRIBIRME`;
}

function cursosCertTexto() {
  return `🎓 CURSOS CON CERTIFICADO (precios)

• Formador de Formadores ($120) – Tatiana Arias
• Inteligencia Emocional ($15) – Tatiana Arias
• Tecnología para Padres ($15) – Yadira Suárez

📌 Próximamente:
• Contabilidad para no contadores ($20)
• Docencia Virtual ($20)
• Habilidades Cognitivas y Emocionales (Aprender a Pensar) ($20)

Si quieres recomendación personalizada, escribe: ASESOR
Si quieres inscribirte, escribe: INSCRIBIRME`;
}

function contactoTexto() {
  return `📞 CONTACTO FUNDACIÓN CAPACÍTAMENTE

📱 0983222358
☎️ 046026948
✉️ info@fundacioncapacitamente.com
📍 Guayaquil - Ecuador`;
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
  return `🕒 HORARIOS (modalidad virtual)

Los horarios son FLEXIBLES: se ajustan a tu disponibilidad porque las clases son 100% online.

📌 Dime tu preferencia:
• Mañana
• Tarde
• Noche`;
}

function beneficiosTexto() {
  return `✅ BENEFICIOS EN FUNDACIÓN CAPACÍTAMENTE

• Formación online accesible y de excelencia.
• Metodología innovadora basada en: tecnología, constructivismo, neurociencia e inteligencia emocional.
• Enfoque social: orientado especialmente a población vulnerable, con compromiso en progreso social, económico y en valores.
• Cursos gratuitos y cursos con certificación a bajo costo.
• Modalidad virtual y flexible.
• Acompañamiento y asesoría para elegir el curso ideal.

Para ver cursos escribe:
• 1 (Cursos gratis)
• 2 (Cursos con certificados y precios)
O escribe: ASESOR`;
}

function misionTexto() {
  return `🎯 NUESTRA MISIÓN

Brindar una formación online de excelencia y accesible, con una metodología innovadora basada en el uso de estrategias tecnológicas, constructivismo, neurociencia e inteligencia emocional, con el objetivo de responder a las necesidades del campo laboral actual, orientada sobre todo a la población más vulnerable, comprometida con el progreso social, económico y en valores de la sociedad.`;
}

function visionTexto() {
  return `🌟 NUESTRA VISIÓN

Ser reconocida nacional e internacionalmente como un referente de educación con enfoque social, dirigida para todo aquel que desee adquirir conocimientos significativos.

• Implementar las mejores e innovadoras estrategias pedagógicas y tecnológicas en sus cursos para lograr mayor integración laboral.
• Consolidarse como el mejor centro de capacitación online y presencial del Ecuador y Latinoamérica.
• Transferir metodologías constructivistas, inteligencia emocional y neurociencia a nivel nacional e internacional.`;
}

function valoresTexto() {
  return `🧭 VALORES

• Disciplina
• Compromiso social
• Liderazgo
• Aprendizaje continuo
• Integridad
• Inclusión
• Empatía`;
}

function pilaresTexto() {
  return `🏛️ NUESTRA DIFERENCIA: PILARES FUNDAMENTALES

Contamos con 4 pilares sobre los cuales se soportan nuestros cursos:
• Tecnología
• Constructivismo
• Inteligencia Emocional
• Neurociencia`;
}

function quienesSomosTexto() {
  return `👥 ¿QUIÉNES SOMOS?

La Fundación Capacítamente nace hace más de 10 años como expresión del compromiso social de su fundadora. En 2021 nace la Fundación Capacítamente “Formando Mentes y Corazones” como Centro de Formación Profesional y Asesorías, para el Trabajo y el Desarrollo Humano, especializada en capacitación en educación, tecnología, inteligencia emocional, neurociencia y más.

Uno de nuestros objetivos es ayudar a las personas a alcanzar sus metas por medio de una educación de alta calidad y al alcance de todos.`;
}

function trabajarConNosotrosTexto() {
  return `🤝 TRABAJA / COLABORA CON NOSOTROS

Para colaborar, ser voluntario/a, proponer alianzas o participar como facilitador/a, contáctanos:

📱 WhatsApp: 0983222358
☎️ 046026948
✉️ info@fundacioncapacitamente.com
📍 Guayaquil - Ecuador`;
}

// Certificarme (sin IA)
function certificarmeIntroTexto() {
  return `📜 CERTIFICACIÓN

Para certificarte, primero elige el CURSO que deseas certificar.

Selecciona una opción:`;
}

// ============================
// Sugerencias (botones)
// ============================
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

function suggestionsAfterInfo() {
  return [
    { text: "menu", label: "📌 Menú" },
    { text: "asesor", label: "✨ Asesor de cursos" },
    { text: "inscribirme", label: "📝 Inscribirme" },
    { text: "3", label: "📞 Contacto" },
  ];
}

function suggestionsFundacionInfo() {
  return [
    { text: "menu", label: "📌 Menú" },
    { text: "quienes somos", label: "👥 ¿Quiénes somos?" },
    { text: "mision", label: "🎯 Misión" },
    { text: "vision", label: "🌟 Visión" },
    { text: "valores", label: "🧭 Valores" },
    { text: "pilares", label: "🏛️ Pilares" },
  ];
}

function suggestionsCertFlow() {
  return [
    { text: "menu", label: "📌 Menú" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
}

function suggestionsScheduleFlowStep1() {
  return [
    { text: "mañana", label: "🌤️ Mañana" },
    { text: "tarde", label: "🌇 Tarde" },
    { text: "noche", label: "🌙 Noche" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsScheduleFlowStep2() {
  return [
    { text: "lun-vie", label: "📅 Lun-Vie" },
    { text: "sabado", label: "📅 Sábado" },
    { text: "domingo", label: "📅 Domingo" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsAfterScheduleSaved() {
  return [
    { text: "inscribirme", label: "📝 Inscribirme" },
    { text: "asesor", label: "✨ Asesor de cursos" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsAdvisorStart() {
  return [
    { text: "docente", label: "👩‍🏫 Docente" },
    { text: "padre", label: "👨‍👩‍👧 Padre/Madre" },
    { text: "estudiante", label: "🎒 Estudiante" },
    { text: "profesional", label: "💼 Profesional" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsAdvisorInterest() {
  return [
    { text: "habilidades blandas", label: "🧠 Habilidades blandas" },
    { text: "tecnologia", label: "💻 Tecnología" },
    { text: "educacion", label: "📚 Educación" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsAdvisorTime() {
  return [
    { text: "1-2", label: "⏱️ 1-2h/semana" },
    { text: "3-5", label: "⏱️ 3-5h/semana" },
    { text: "5+", label: "⏱️ +5h/semana" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsLeadFlow() {
  return [
    { text: "menu", label: "📌 Menú" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
}

function suggestionsCertificarmeCursos() {
  return [
    { text: "Formador de Formadores", label: "🎓 Formador de Formadores ($120)" },
    { text: "Inteligencia Emocional", label: "🎓 Inteligencia Emocional ($15)" },
    { text: "Tecnología para Padres", label: "🎓 Tecnología para Padres ($15)" },
    { text: "menu", label: "📌 Menú" },
    { text: "cancelar", label: "✖ Cancelar" },
  ];
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
  return ["menu", "menú", "opciones", "inicio", "start", "0"].includes(s);
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
    s.includes("quiero trabajar") ||
    s.includes("empleo") ||
    s.includes("vacante") ||
    s.includes("voluntario") ||
    s.includes("colaborar") ||
    s.includes("alianza")
  );
}

function isCertificarmeQuery(t) {
  const s = normalizeText(t);
  return (
    s.includes("certificarme") ||
    s.includes("como certificarme") ||
    s.includes("certificacion") ||
    s.includes("certificación") ||
    s.includes("certificar")
  );
}

function isMissionQuery(t) {
  const s = normalizeText(t);
  return s === "mision" || s === "misión" || s.includes("mision") || s.includes("misión");
}

function isVisionQuery(t) {
  const s = normalizeText(t);
  return s === "vision" || s === "visión" || s.includes("vision") || s.includes("visión");
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
  return (
    s.includes("quienes son") ||
    s.includes("quienes somos") ||
    s.includes("quiénes son") ||
    s.includes("quiénes somos") ||
    s.includes("historia") ||
    s.includes("acerca de") ||
    s.includes("nosotros")
  );
}

function isFoundationQuery(t) {
  const s = normalizeText(t);
  const keys = [
    "fundacion","fundación","capacitamente","capacítamente",
    "curso","cursos","certificado","certificacion","certificación","certificar","certificarme",
    "donar","donacion","donación","donaciones","paypal","transferencia",
    "whatsapp","correo","contacto","guayaquil",
    "tatiana","yadira",
    "formador de formadores","inteligencia emocional","tecnologia para padres","tecnología para padres",
    "tecnologia para educadores","tecnología para educadores",
    "horario","horarios","inscribirme","inscripcion","inscripción",
    "beneficio","beneficios","ventajas",
    "mision","misión","vision","visión","valores","pilares",
    "quienes somos","quiénes somos","acerca de","nosotros",
    "trabaja con nosotros","trabajar","vacante","empleo","voluntario","colaborar","alianza"
  ];
  return keys.some((k) => s.includes(normalizeText(k)));
}

// ============================
// Flujos
// ============================
const certFlow = new Map();         // sessionId -> { step }
const advisorFlow = new Map();      // sessionId -> { step, persona, interes, tiempo }
const leadFlow = new Map();         // sessionId -> { step, data: { nombre, whatsapp, curso, schedule_pref_id } }
const scheduleFlow = new Map();     // sessionId -> { step, data: { franja, dias } }
const certificarmeFlow = new Map(); // sessionId -> { step }

// recordar el último horario guardado por sesión para enlazar inscripción
const lastSchedulePrefId = new Map(); // sessionId -> id

function resetFlows(sessionId) {
  certFlow.delete(sessionId);
  advisorFlow.delete(sessionId);
  leadFlow.delete(sessionId);
  scheduleFlow.delete(sessionId);
  certificarmeFlow.delete(sessionId);
  // NO borramos lastSchedulePrefId aquí
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
    const last =
      data && typeof data.conversation_number === "number"
        ? data.conversation_number
        : 0;
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

async function ensureSession(sessionId, userKey) {
  if (!supabase) return;

  const now = new Date().toISOString();
  const existing = await getSession(sessionId);

  if (!existing) {
    const nextNum = await getNextConversationNumber(userKey);

    const row = {
      session_id: sessionId,
      user_key: userKey,
      last_seen: now,
    };
    if (typeof nextNum === "number") row.conversation_number = nextNum;

    await insertSessionRow(row);

    // saludo en historial
    await insertChatMessage(sessionId, userKey, "bot", menuOpcionesTexto());
    await touchSessionLastMessage(sessionId, userKey, "Conversación nueva");
    return;
  }

  if (existing.user_key !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const { error: upErr } = await supabase
    .from("chat_sessions")
    .update({ last_seen: now })
    .eq("session_id", sessionId);

  if (upErr) throw upErr;
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
    .update({
      last_seen: now,
      last_message_at: now,
      last_message_preview: preview,
    })
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

  const { error } = await supabase
    .from("chat_messages")
    .insert([{ session_id: sessionId, role, content }]);

  if (error) throw error;
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
  const payload = pinned
    ? { pinned: true, pinned_at: now }
    : { pinned: false, pinned_at: null };

  const { error } = await supabase
    .from("chat_sessions")
    .update(payload)
    .eq("session_id", sessionId);

  if (error) throw error;
}

// ============================
// Certificado (mejorado)
// ============================
function extractCedula(text) {
  const m = String(text || "").match(/\b\d{10}\b/);
  return m ? m[0] : "";
}

function extractCourse(text, cedula) {
  let s = String(text || "");
  if (cedula) s = s.replace(cedula, "");
  s = s.replace(/[-,:]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function certAskText() {
  return `📄 ESTADO DE CERTIFICADO

Escribe tu CÉDULA (10 dígitos) y el NOMBRE DEL CURSO.

Ejemplo:
0923456789 - Inteligencia Emocional

(Para salir escribe: MENU)`;
}

async function getCertificateStatus(cedula, curso) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("certificate_status")
    .select("estado, updated_at, curso")
    .eq("cedula", cedula)
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

Si aún no lo recibiste, escríbenos:
📱 0983222358
☎️ 046026948
✉️ info@fundacioncapacitamente.com`;
  }

  if (estado === "en_proceso") {
    return `⏳ CERTIFICADO EN PROCESO

Curso: ${row.curso}
Actualizado: ${updated}

Sugerencia: vuelve a consultar más tarde.`;
  }

  if (estado === "no_listo") {
    return `⚠️ CERTIFICADO AÚN NO LISTO

Curso: ${row.curso}
Actualizado: ${updated}

Si necesitas ayuda, contáctanos:
📱 0983222358
☎️ 046026948
✉️ info@fundacioncapacitamente.com`;
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

  const base = {
    user_key: userKey,
    session_id: sessionId,
    nombre: data.nombre,
    curso: data.curso,
  };

  const attempts = [
    { ...base, whatsapp: data.whatsapp, schedule_pref_id: schedulePrefId },
    { ...base, WhatsApp: data.whatsapp, schedule_pref_id: schedulePrefId },
    { ...base, whatsapp: data.whatsapp },
    { ...base, WhatsApp: data.whatsapp },
  ];

  let lastErr = null;
  for (const row of attempts) {
    const { error } = await supabase.from("leads").insert([row]);
    if (!error) return;
    lastErr = error;
  }
  throw lastErr;
}

function extractWhatsapp(text) {
  const raw = String(text || "").replace(/\s+/g, "");
  const m = raw.match(/(\+?\d{9,15})/);
  return m ? m[1] : "";
}

// ============================
// Preferencia de horario (GUARDADO + devuelve ID si existe)
// ============================
function pickScheduleId(row) {
  if (!row) return null;
  return (
    row.id ??
    row.identificacion ??
    row["identificación"] ??
    row.identificacion_id ??
    null
  );
}

async function saveSchedule(userKey, sessionId, data) {
  if (!supabase) return { id: null };

  const try1 = await supabase
    .from("schedule_preferences")
    .insert([
      {
        user_key: userKey,
        session_id: sessionId,
        franja: data.franja,
        dias: data.dias,
      },
    ])
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
      .insert([
        {
          user_key: userKey,
          session_id: sessionId,
          preferencia: pref,
        },
      ])
      .select("*");

    if (try2.error) throw try2.error;

    const row = try2.data && try2.data[0] ? try2.data[0] : null;
    return { id: pickScheduleId(row), row };
  }

  throw try1.error;
}

// ============================
// Asesor (recomendador) - SIN IA (reglas)
// ============================
function recommendCourse({ persona, interes, tiempo }) {
  const p = normalizeText(persona);
  const i = normalizeText(interes);
  const t = normalizeText(tiempo);

  if (p.includes("padre")) {
    return {
      curso: "Tecnología para Padres ($15)",
      motivo: "ideal si quieres acompañar y guiar mejor el uso de tecnología en casa.",
    };
  }

  if (p.includes("docente")) {
    if (i.includes("tecnolog")) {
      return {
        curso: "Tecnología para Educadores (Gratis)",
        motivo: "enfocado a herramientas y recursos útiles para docentes.",
      };
    }
    return {
      curso: "Formador de Formadores ($120)",
      motivo: "perfecto para fortalecer habilidades de enseñanza y facilitación.",
    };
  }

  if (i.includes("habilidades") || i.includes("blandas")) {
    return {
      curso: "Inteligencia Emocional ($15)",
      motivo: "fortalece comunicación, manejo de emociones y relaciones.",
    };
  }

  if (i.includes("educa")) {
    return {
      curso: "Formador de Formadores ($120)",
      motivo: "te ayuda a estructurar sesiones y enseñar con mejor metodología.",
    };
  }

  if (i.includes("tecnolog")) {
    return {
      curso: "Tecnología para Educadores (Gratis)",
      motivo: "una base útil para avanzar rápido sin costo.",
    };
  }

  if (t === "1-2") {
    return {
      curso: "Inteligencia Emocional ($15)",
      motivo: "es una opción ligera y muy aplicable día a día.",
    };
  }

  return {
    curso: "Formador de Formadores ($120)",
    motivo: "muy completo si quieres una formación sólida.",
  };
}

// ============================
// IA en memoria + límites
// ============================
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 300;

const MAX_DAILY_AI_CALLS = Number(process.env.MAX_DAILY_AI_CALLS || 50);
let aiCallsToday = 0;
let aiCallsDayKey = getDayKeyEC();

// cooldown real por sesión
const aiLastCallAt = new Map(); // sessionId -> timestamp

function getDayKeyEC() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastAccess > SESSION_TTL_MS) sessions.delete(sid);
  }
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    );
    const extra = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < extra; i++) sessions.delete(ordered[i][0]);
  }
}, 60 * 1000);

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
// Routes
// ============================
app.get("/health", (req, res) => res.status(200).send("ok"));

// Lista sesiones (con PIN si existe)
app.get("/sessions", async (req, res) => {
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

      let q = supabase
        .from("chat_sessions")
        .select(fields)
        .eq("user_key", userKey);

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
  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const userKey = getUserKey(req);
    const sessionId = newSessionId();

    await ensureSession(sessionId, userKey);
    return sendJson(res, { sessionId }, 200);
  } catch (e) {
    return sendJson(res, { error: "Error creando sesión", details: String(e?.message || e) }, 500);
  }
});

// PIN / UNPIN
app.post("/session/:sessionId/pin", async (req, res) => {
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
        return sendJson(
          res,
          {
            error: "Tu tabla chat_sessions no tiene columnas de PIN.",
            hint: "Agrega columnas pinned y pinned_at.",
          },
          400
        );
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
  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return sendJson(res, { error: "Falta sessionId" }, 400);

    const userKey = getUserKey(req);

    const s = await getSession(sessionId);
    if (!s) return sendJson(res, { error: "Sesión no encontrada." }, 404);
    if (s.user_key !== userKey)
      return sendJson(res, { error: "No autorizado para borrar esta sesión." }, 403);

    const { error: mErr } = await supabase.from("chat_messages").delete().eq("session_id", sessionId);
    if (mErr) return sendJson(res, { error: "Error borrando mensajes", details: mErr.message }, 500);

    const { error: dErr } = await supabase.from("chat_sessions").delete().eq("session_id", sessionId);
    if (dErr) return sendJson(res, { error: "Error borrando sesión", details: dErr.message }, 500);

    sessions.delete(sessionId);
    resetFlows(sessionId);
    lastSchedulePrefId.delete(sessionId);
    aiLastCallAt.delete(sessionId);

    return sendJson(res, { ok: true, sessionId }, 200);
  } catch (e) {
    const status = extractStatus(e) || 500;
    return sendJson(res, { error: "Error interno", details: String(e?.message || e) }, status);
  }
});

// Historial
app.get("/history/:sessionId", async (req, res) => {
  try {
    if (!supabase) return sendJson(res, { error: "Supabase no configurado." }, 500);

    const userKey = getUserKey(req);
    const sessionId = String(req.params.sessionId || "").trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const s = await getSession(sessionId);
    if (!s || s.user_key !== userKey)
      return sendJson(res, { error: "Sesión no encontrada." }, 404);

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
  try {
    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();

    if (!userMessage) return sendJson(res, { reply: "Mensaje no proporcionado." }, 400);
    if (!sessionId) sessionId = newSessionId();

    const userKey = getUserKey(req);

    // Asegurar sesión
    if (supabase) await ensureSession(sessionId, userKey);

    // Guardar msg usuario
    if (supabase) {
      await insertChatMessage(sessionId, userKey, "user", userMessage);
      await touchSessionLastMessage(sessionId, userKey, userMessage);
    }

    const t = normalizeText(userMessage);

    // ====== comandos globales (SIN IA) ======
    if (isGreeting(t) || isMenuCommand(t)) {
      resetFlows(sessionId);
      const reply = menuOpcionesTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    if (t === "cancelar") {
      resetFlows(sessionId);
      const reply = "✅ Listo. Cancelé el proceso. Escribe MENU para ver opciones.";
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // ====== FUNDACIÓN: info directa (SIN IA) ======
    if (isBenefitsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = beneficiosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
    }

    if (isWorkWithUsQuery(userMessage)) {
      resetFlows(sessionId);
      const reply = trabajarConNosotrosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
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

    // ====== FUNDACIÓN: certificarme (SIN IA) ======
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

    // ====== números del menú (SIN IA) ======
    if (/^[1-6]$/.test(t)) {
      resetFlows(sessionId);

      if (t === "1") {
        const reply = cursosGratisTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
      }

      if (t === "2") {
        const reply = cursosCertTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
      }

      if (t === "3") {
        const reply = contactoTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
      }

      if (t === "4") {
        const reply = donarTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
      }

      if (t === "5") {
        certFlow.set(sessionId, { step: "need_data" });
        const reply = certAskText();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
      }

      if (t === "6") {
        scheduleFlow.set(sessionId, { step: "franja", data: {} });
        const reply = horariosTexto();
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
      }
    }

    // ====== disparadores por palabra (SIN IA) ======
    if (t.includes("asesor") || t.includes("recomendar") || t.includes("recomendacion") || t.includes("recomendación")) {
      resetFlows(sessionId);
      advisorFlow.set(sessionId, { step: "persona", persona: "", interes: "", tiempo: "" });

      const reply = `✨ ASESOR DE CURSOS (3 preguntas)

1/3) ¿Cuál te describe mejor?
• Docente
• Padre/Madre
• Estudiante
• Profesional`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorStart() }, 200);
    }

    if (t.includes("inscrib") || t.includes("inscripcion") || t.includes("inscripción")) {
      resetFlows(sessionId);

      const schedId = lastSchedulePrefId.get(sessionId) || null;

      leadFlow.set(sessionId, {
        step: "nombre",
        data: { nombre: "", whatsapp: "", curso: "", schedule_pref_id: schedId },
      });

      const extra = schedId ? "\n✅ Ya tengo tu horario guardado y lo vincularé a tu inscripción." : "";
      const reply = `📝 INSCRIPCIÓN RÁPIDA${extra}

Para ayudarte mejor, dime tu NOMBRE (solo nombre y apellido).`;

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
    }

    if (t.includes("horario")) {
      resetFlows(sessionId);
      scheduleFlow.set(sessionId, { step: "franja", data: {} });
      const reply = horariosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
    }

    if (t.includes("donaci") || t.includes("donar")) {
      const reply = donarTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    if (t.includes("contact") || t.includes("whatsapp") || t.includes("correo")) {
      const reply = contactoTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    if (t.includes("gratis") || t.includes("gratuito")) {
      const reply = cursosGratisTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
    }

    if (t.includes("precio") || t.includes("costo") || (t.includes("curso") && (t.includes("pago") || t.includes("con certificado")))) {
      const reply = cursosCertTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
    }

    // ====== FLUJO CERTIFICARME (SIN IA) ======
    if (certificarmeFlow.has(sessionId)) {
      const st = certificarmeFlow.get(sessionId);

      if (st.step === "choose_course") {
        const cursoElegido = userMessage.trim();

        const opciones = ["Formador de Formadores", "Inteligencia Emocional", "Tecnología para Padres"];
        const norm = normalizeText(cursoElegido);

        const match =
          opciones.find((o) => normalizeText(o) === norm) ||
          opciones.find((o) => norm.includes(normalizeText(o)));

        if (!match) {
          const reply = "Por favor selecciona un curso de la lista para continuar.";
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCertificarmeCursos() }, 200);
        }

        certificarmeFlow.delete(sessionId);

        // Pasa directo a inscripción con curso preseleccionado
        const schedId = lastSchedulePrefId.get(sessionId) || null;
        leadFlow.set(sessionId, {
          step: "nombre",
          data: { nombre: "", whatsapp: "", curso: match, schedule_pref_id: schedId },
        });

        const extra = schedId ? "\n✅ Ya tengo tu horario guardado y lo vincularé a tu inscripción." : "";
        const reply = `✅ Perfecto. Para certificarte en:
🎓 ${match}

Necesitamos registrarte.${extra}

Dime tu NOMBRE (solo nombre y apellido).`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }
    }

    // ====== FLUJO CERTIFICADO (estado) ======
    if (certFlow.has(sessionId)) {
      const cedula = extractCedula(userMessage);
      const curso = extractCourse(userMessage, cedula);

      if (!cedula) {
        const reply = `Por favor escribe tu CÉDULA (10 dígitos).
Ejemplo: 0923456789
(Para salir: MENU)`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
      }

      if (!curso || curso.length < 3) {
        const reply = `✅ Cédula recibida (${cedula})

Ahora escribe el NOMBRE DEL CURSO.
Ejemplo: Inteligencia Emocional
(Para salir: MENU)`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsCertFlow() }, 200);
      }

      let reply;
      try {
        const row = await getCertificateStatus(cedula, curso);
        if (!row) {
          reply = `No encuentro un registro para:
• Cédula: ${cedula}
• Curso: ${curso}

Si crees que es un error, contáctanos:
📱 0983222358
☎️ 046026948
✉️ info@fundacioncapacitamente.com`;
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
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // ====== FLUJO ASESOR (SIN IA) ======
    if (advisorFlow.has(sessionId)) {
      const st = advisorFlow.get(sessionId);

      if (st.step === "persona") {
        st.persona = userMessage.trim();
        st.step = "interes";
        advisorFlow.set(sessionId, st);

        const reply = `2/3) ¿Qué buscas principalmente?

• Habilidades blandas
• Tecnología
• Educación`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorInterest() }, 200);
      }

      if (st.step === "interes") {
        st.interes = userMessage.trim();
        st.step = "tiempo";
        advisorFlow.set(sessionId, st);

        const reply = `3/3) ¿Cuánto tiempo tienes a la semana?

• 1-2
• 3-5
• 5+`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAdvisorTime() }, 200);
      }

      if (st.step === "tiempo") {
        st.tiempo = userMessage.trim();
        advisorFlow.delete(sessionId);

        const rec = recommendCourse(st);

        const reply = `✅ RECOMENDACIÓN PERSONALIZADA

Según lo que me dijiste, te recomiendo:
🎯 ${rec.curso}

Motivo: ${rec.motivo}

Si quieres, te ayudo a inscribirte:
Escribe: INSCRIBIRME`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
      }
    }

    // ====== FLUJO INSCRIPCIÓN ======
    if (leadFlow.has(sessionId)) {
      const st = leadFlow.get(sessionId);

      if (st.step === "nombre") {
        st.data.nombre = userMessage.trim();
        st.step = "whatsapp";
        leadFlow.set(sessionId, st);

        const reply = `✅ Gracias, ${st.data.nombre}.

Ahora escribe tu número de WhatsApp.
Ejemplo: +593991112233 o 0991112233`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
      }

      if (st.step === "whatsapp") {
        const w = extractWhatsapp(userMessage);
        if (!w) {
          const reply = `No pude leer el número 😅
Escríbelo así: +593991112233 o 0991112233`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsLeadFlow() }, 200);
        }

        st.data.whatsapp = w;

        // si el curso ya venía preseleccionado (certificarme), cerramos aquí
        if (st.data.curso && String(st.data.curso).trim().length > 0) {
          st.data.schedule_pref_id =
            st.data.schedule_pref_id ?? (lastSchedulePrefId.get(sessionId) || null);

          try {
            await saveLead(userKey, sessionId, st.data);
          } catch (e) {
            console.warn("⚠️ No se pudo guardar lead:", extractMessage(e));
          }

          leadFlow.delete(sessionId);

          const extra = st.data.schedule_pref_id
            ? `\nHorario vinculado (ID): ${st.data.schedule_pref_id}`
            : "";
          const reply = `✅ ¡Listo! Recibimos tus datos.

Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}
Curso: ${st.data.curso}${extra}

En breve te contactaremos por WhatsApp.
Si quieres ver opciones: escribe MENU`;

          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }

          return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
        }

        // si NO hay curso, seguimos normal
        st.step = "curso";
        st.data.schedule_pref_id =
          st.data.schedule_pref_id ?? (lastSchedulePrefId.get(sessionId) || null);
        leadFlow.set(sessionId, st);

        const reply = `Perfecto ✅

¿En qué CURSO te gustaría inscribirte?
(Ej: Inteligencia Emocional / Formador de Formadores / Tecnología para Padres)`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
      }

      if (st.step === "curso") {
        st.data.curso = userMessage.trim();
        st.data.schedule_pref_id =
          st.data.schedule_pref_id ?? (lastSchedulePrefId.get(sessionId) || null);

        try {
          await saveLead(userKey, sessionId, st.data);
        } catch (e) {
          console.warn("⚠️ No se pudo guardar lead:", extractMessage(e));
        }

        leadFlow.delete(sessionId);

        const extra = st.data.schedule_pref_id
          ? `\nHorario vinculado (ID): ${st.data.schedule_pref_id}`
          : "";
        const reply = `✅ ¡Listo! Recibimos tus datos.

Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}
Curso: ${st.data.curso}${extra}

En breve te contactaremos por WhatsApp.
Si quieres ver opciones: escribe MENU`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
      }
    }

    // ====== FLUJO HORARIO ======
    if (scheduleFlow.has(sessionId)) {
      const st = scheduleFlow.get(sessionId);

      if (st.step === "franja") {
        const v = normalizeText(userMessage);
        const ok = ["manana", "tarde", "noche"].includes(v);
        if (!ok) {
          const reply = `Dime tu preferencia escribiendo:
• Mañana
• Tarde
• Noche
(Para salir: MENU)`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
        }

        st.data.franja = v;
        st.step = "dias";
        scheduleFlow.set(sessionId, st);

        const reply = `✅ Anotado: ${v.toUpperCase()}.

¿En qué días se te facilita más?
• Lun-Vie
• Sábado
• Domingo`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep2() }, 200);
      }

      if (st.step === "dias") {
        st.data.dias = normalizeText(userMessage).trim();

        let saved = true;
        let schedId = null;

        try {
          const out = await saveSchedule(userKey, sessionId, st.data);
          schedId = out?.id ?? null;
          if (schedId) lastSchedulePrefId.set(sessionId, schedId);
        } catch (e) {
          saved = false;
          console.warn("⚠️ No se pudo guardar horario:", extractMessage(e));
        }

        scheduleFlow.delete(sessionId);

        const reply = saved
          ? `✅ ¡Gracias! Guardé tu preferencia de horario.

Franja: ${st.data.franja}
Días: ${st.data.dias}

¿Deseas inscribirte a un curso ahora?
Escribe: INSCRIBIRME`
          : `✅ Preferencia recibida (pero OJO: no se pudo guardar en la BD todavía).

Franja: ${st.data.franja}
Días: ${st.data.dias}

Revisa que en Render estén SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }

        return sendJson(
          res,
          {
            reply,
            sessionId,
            suggestions: saved ? suggestionsAfterScheduleSaved() : suggestionsMenu(),
          },
          200
        );
      }
    }

    // ✅ Si es tema Fundación y no cayó en una ruta específica -> NO usamos IA
    if (isFoundationQuery(userMessage)) {
      const reply = `Puedo ayudarte con información de la Fundación Capacítamente.

Escribe:
• MENU (ver opciones)
• QUIENES SOMOS
• MISION
• VISION
• VALORES
• PILARES
• BENEFICIOS
• CERTIFICARME
• TRABAJA CON NOSOTROS`;

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }

      return sendJson(res, { reply, sessionId, suggestions: suggestionsFundacionInfo() }, 200);
    }

    // ============================
    // Si no cayó en Fundación/FAQ/Flujos -> IA
    // ============================
    if (!ai) {
      const msg =
        "Ahora mismo solo puedo ayudarte con el menú e información de la Fundación. Escribe MENU para ver opciones.";
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return sendJson(res, { reply: msg, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // ✅ No devolvemos 429/503: devolvemos 200 con fallback neutro tipo menú
    if (!canUseAI()) {
      const msg = aiFallbackMenuText();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", msg);
        await touchSessionLastMessage(sessionId, userKey, msg);
      }
      return sendJson(res, { reply: msg, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // Cooldown por sesión
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

    // Crear / recuperar sesión IA
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

    incAI();

    // ✅ Reintentos automáticos si el modelo está ocupado
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

    if (supabase) {
      await insertChatMessage(sessionId, userKey, "bot", reply);
      await touchSessionLastMessage(sessionId, userKey, reply);
    }

    return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
  } catch (error) {
    const status = extractStatus(error);
    const msg = extractMessage(error);
    console.error("❌ Error /chat:", msg);

    if (status === 403) {
      return sendJson(
        res,
        { reply: "Esta conversación no te pertenece. Crea una nueva (botón Nueva).", sessionId: "" },
        403
      );
    }

    // ✅ Cualquier error de Gemini/429/503: NO mandamos error, mandamos fallback neutro tipo menú
    if (
      status === 429 ||
      status === 503 ||
      /RESOURCE_EXHAUSTED|quota|rate limit|429|overloaded|NO DISPONIBLE/i.test(msg)
    ) {
      const reply = aiFallbackMenuText();
      return sendJson(
        res,
        { reply, sessionId: String(req.body?.sessionId || ""), suggestions: suggestionsMenu() },
        200
      );
    }

    // ✅ Error genérico: también sin romper el frontend
    const reply = aiFallbackMenuText();
    return sendJson(
      res,
      { reply, sessionId: String(req.body?.sessionId || ""), suggestions: suggestionsMenu() },
      200
    );
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
  console.log(
    `🤖 Gemini: modelo=${GEMINI_MODEL} tokens=${GEMINI_MAX_TOKENS} temperatura=${GEMINI_TEMPERATURE}`
  );
  console.log(
    `⏱️ Cooldown(ms)=${AI_COOLDOWN_MS} | max diarios IA=${MAX_DAILY_AI_CALLS} | retries=${GEMINI_RETRIES}`
  );
});

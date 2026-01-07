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
app.use(express.json({ strict: false, limit: "2mb" }));

// ============================
// IA (Gemini) - SOLO si no cae en FAQ/Flujos
// ============================
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) console.warn("⚠️ Falta GEMINI_API_KEY (o GOOGLE_API_KEY). El bot funcionará en modo FAQ sin IA.");

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ============================
// Supabase
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  console.log("✅ Supabase configurada: verdadero");
} else {
  console.warn("⚠️ Supabase NO configurada. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
}

// ============================
// System instruction (IA)
// ============================
const systemInstruction = `
Eres Lyro-Capacítamente, asistente virtual oficial de la Fundación Capacítamente (Guayaquil - Ecuador).
IMPORTANTE:
- Si el usuario habla de "empresa", "institución", "capacitaciones", "beneficios", "certificados", debes responder sobre la Fundación Capacítamente.
- Responde claro, útil y sin inventar. Si no sabes un dato exacto, ofrece Contacto.
- Usa el menú cuando sea útil.

Información clave:
- Fundación Capacítamente (sin fines de lucro): capacitación de alto valor en habilidades blandas y digitales.
- Cursos con Certificado:
  - Formador de Formadores ($120): Tatiana Arias.
  - Inteligencia Emocional ($15): Tatiana Arias.
  - Tecnología para Padres ($15): Yadira Suárez.
- Cursos Gratuitos:
  - Tecnología para Educadores: Tatiana Arias.
- Contacto:
  - Celular: 0983222358
  - Correo: info@fundacioncapacitamente.com
  - Ubicación: Guayaquil - Ecuador
- Donaciones:
  1) Donaciones -> "Donar ahora"
  2) Elegir cantidad o personalizada -> "Continuar"
  3) Llenar datos
  4) Elegir método (Transferencia o PayPal)
  5) "Donar ahora"
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

function isMissingRelation(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("relation") || msg.includes("not found") || String(err?.code || "") === "42P01";
}

function isMissingColumn(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("column") && msg.includes("does not exist");
}

// ============================
// Textos (sin markdown)
// ============================
function menuOpcionesTexto() {
  return `👋 Hola, soy LYRO-CAPACÍTAMENTE 🤖

¿En qué te puedo ayudar?

📌 MENÚ PRINCIPAL (elige una opción)

1) Cursos gratis
2) Cursos con certificados y precios
3) Contacto
4) Donar
5) Estado de certificado
6) Horarios

Responde con el número (1-6) o escribe tu pregunta.`;
}

function horariosTexto() {
  return `🕒 HORARIOS (modalidad virtual)

Los horarios son FLEXIBLES: se ajustan a tu disponibilidad porque las clases son 100% online.

📌 Dime tu preferencia:
• Mañana
• Tarde
• Noche`;
}

function cursosGratisTexto() {
  return `🎓 CURSOS GRATUITOS

• Tecnología para Educadores – Tatiana Arias

Si quieres recomendación personalizada, escribe: ASESOR
Si quieres inscribirte, escribe: INSCRIBIRME`;
}

function cursosCertTexto() {
  return `🎓 CURSOS CON CERTIFICADO (precios)

• Formador de Formadores ($120) – Tatiana Arias
• Inteligencia Emocional ($15) – Tatiana Arias
• Tecnología para Padres ($15) – Yadira Suárez

Si quieres inscribirte y certificarte, escribe: INSCRIBIRME`;
}

function contactoTexto() {
  return `📞 CONTACTO FUNDACIÓN CAPACÍTAMENTE

📱 0983222358
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

function beneficiosTexto() {
  return `✅ BENEFICIOS EN FUNDACIÓN CAPACÍTAMENTE

La Fundación Capacítamente (sin fines de lucro) te ayuda con:
• Capacitación en habilidades blandas y digitales.
• Cursos gratuitos y cursos con certificado.
• Horarios flexibles (100% online).
• Acompañamiento para inscribirte y resolver dudas.

Si quieres, dime qué te interesa:
1) Cursos gratis
2) Certificados y precios
6) Horarios`;
}

function certificarTexto() {
  return `🎓 CERTIFICARTE EN UN CURSO

Para certificarte, primero debes INSCRIBIRTE en un curso con certificado.

📌 Elige el curso que deseas:`;
}

// ============================
// Botones (sugerencias)
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
    { text: "inscribirme", label: "📝 Inscribirme" },
    { text: "asesor", label: "✨ Asesor" },
    { text: "3", label: "📞 Contacto" },
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

const COURSE_OPTIONS = [
  { key: "1", name: "Formador de Formadores", label: "1) Formador de Formadores ($120)" },
  { key: "2", name: "Inteligencia Emocional", label: "2) Inteligencia Emocional ($15)" },
  { key: "3", name: "Tecnología para Padres", label: "3) Tecnología para Padres ($15)" },
];

function suggestionsCoursePick() {
  return [
    { text: "1", label: "1) Formador de Formadores ($120)" },
    { text: "2", label: "2) Inteligencia Emocional ($15)" },
    { text: "3", label: "3) Tecnología para Padres ($15)" },
    { text: "cancelar", label: "✖ Cancelar" },
    { text: "menu", label: "📌 Menú" },
  ];
}

function suggestionsPostScheduleCTA() {
  return [
    { text: "inscribirme", label: "📝 Inscribirme" },
    { text: "2", label: "🎓 Cursos con certificado" },
    { text: "menu", label: "📌 Menú" },
  ];
}

// ============================
// FAQ
// ============================
function isGreeting(t) {
  const s = normalizeText(t);
  return ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hello", "hi"].includes(s);
}
function isMenuCommand(t) {
  const s = normalizeText(t);
  return ["menu", "menú", "opciones", "inicio", "start", "0"].includes(s);
}

// ============================
// DB Maps (auto-detect)
// ============================
const MAPS = {
  sessions: [
    {
      table: "chat_sessions",
      cols: {
        sid: "session_id",
        user: "user_key",
        created: "created_at",
        lastSeen: "last_seen",
        lastMsgAt: "last_message_at",
        lastPreview: "last_message_preview",
        conv: "conversation_number",
        pinned: "pinned",
        pinnedAt: "pinned_at",
      },
    },
    {
      table: "sesiones_de_chat",
      cols: {
        sid: "id_de_sesion",
        user: "clave_de_usuario",
        created: "creado_en",
        lastSeen: "ultima_vez_visto",
        lastMsgAt: "ultimo_mensaje_at",
        lastPreview: "vista_previa_del_ultimo_mensaje",
        conv: "numero_de_conversacion",
        pinned: "fijado",
        pinnedAt: "fijado_en",
      },
    },
  ],
  messages: [
    {
      table: "chat_messages",
      cols: { sid: "session_id", role: "role", content: "content", created: "created_at" },
    },
    {
      table: "mensajes_de_chat",
      cols: { sid: "id_de_sesion", role: "role", content: "contenido", created: "creado_en" },
    },
  ],
  leads: [
    {
      table: "leads",
      cols: { user: "user_key", sid: "session_id", nombre: "nombre", whatsapp: "whatsapp", curso: "curso", scheduleId: "schedule_pref_id" },
    },
    {
      table: "inscribirse",
      cols: { user: "clave_de_usuario", sid: "id_de_sesion", nombre: "nombre", whatsapp: "WhatsApp", curso: "curso", scheduleId: "schedule_pref_id" },
    },
  ],
  schedule: [
    {
      table: "schedule_preferences",
      cols: { id: "id", user: "user_key", sid: "session_id", franja: "franja", dias: "dias", preferencia: "preferencia", created: "created_at" },
    },
    {
      table: "preferencias_de_programacion",
      cols: { id: "identificacion", user: "clave_de_usuario", sid: "id_de_sesion", franja: "franja", dias: "dias", preferencia: "preferencia", created: "creado_en" },
    },
  ],
  cert: [
    {
      table: "certificate_status",
      cols: { cedula: "cedula", curso: "curso", estado: "estado", updated: "updated_at" },
    },
    {
      table: "certificados_estado",
      cols: { cedula: "cedula", curso: "curso_nombre", estado: "estado", updated: "actualizado_en" },
    },
    {
      table: "estado_del_certificado",
      cols: { cedula: "cedula", curso: "curso", estado: "estado", updated: "actualizado_en" },
    },
  ],
};

const DB = { ready: false, sessions: null, messages: null, leads: null, schedule: null, cert: null, scheduleMode: "json" };

async function detectFirst(list) {
  for (const m of list) {
    const { error } = await supabase.from(m.table).select("*").limit(1);
    if (!error) return m;
    if (isMissingRelation(error)) continue;
    // si es permiso o RLS, igual tomamos como existente
    return m;
  }
  return null;
}

async function initDbMaps() {
  if (!supabase || DB.ready) return;

  DB.sessions = await detectFirst(MAPS.sessions);
  DB.messages = await detectFirst(MAPS.messages);
  DB.leads = await detectFirst(MAPS.leads);
  DB.schedule = await detectFirst(MAPS.schedule);
  DB.cert = await detectFirst(MAPS.cert);

  // Detecta si schedule tiene franja/dias o solo preferencia
  if (DB.schedule) {
    const c = DB.schedule.cols;
    const r = await supabase.from(DB.schedule.table).select(`${c.franja},${c.dias}`).limit(1);
    DB.scheduleMode = r.error ? "json" : "split";
  }

  DB.ready = true;

  console.log("🧩 DB map:", {
    sessions: DB.sessions?.table || null,
    messages: DB.messages?.table || null,
    leads: DB.leads?.table || null,
    schedule: DB.schedule?.table || null,
    scheduleMode: DB.scheduleMode,
    cert: DB.cert?.table || null,
  });
}

// ============================
// Flujos
// ============================
const certFlow = new Map();     // sessionId -> {}
const advisorFlow = new Map();  // (lo dejamos por si lo usas luego)
const leadFlow = new Map();     // sessionId -> { step, data, needSchedule }
const scheduleFlow = new Map(); // sessionId -> { step, data }
const lastScheduleId = new Map(); // sessionId -> id guardado

function resetFlows(sessionId) {
  certFlow.delete(sessionId);
  advisorFlow.delete(sessionId);
  leadFlow.delete(sessionId);
  scheduleFlow.delete(sessionId);
}

// ============================
// DB helpers (compatibles)
// ============================
async function getSessionRow(sessionId) {
  await initDbMaps();
  if (!supabase || !DB.sessions) return null;

  const c = DB.sessions.cols;
  const { data, error } = await supabase
    .from(DB.sessions.table)
    .select(`${c.sid}, ${c.user}`)
    .eq(c.sid, sessionId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getNextConversationNumber(userKey) {
  await initDbMaps();
  if (!supabase || !DB.sessions) return null;

  const c = DB.sessions.cols;
  // intentamos si existe la columna conv
  const { data, error } = await supabase
    .from(DB.sessions.table)
    .select(c.conv)
    .eq(c.user, userKey)
    .order(c.conv, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingColumn(error)) return null;
    return null;
  }
  const last = data && typeof data[c.conv] === "number" ? data[c.conv] : 0;
  return last + 1;
}

async function safeUpdate(table, filterCol, filterVal, updates) {
  // si falta una columna, la quitamos y reintentamos
  let payload = { ...updates };
  for (let i = 0; i < 6; i++) {
    const { error } = await supabase.from(table).update(payload).eq(filterCol, filterVal);
    if (!error) return true;

    const msg = String(error.message || "");
    const m = msg.match(/column "([^"]+)"/i);
    if (m && payload[m[1]] !== undefined) {
      delete payload[m[1]];
      continue;
    }
    // fallback: si dice "could not find the 'xxx' column"
    const m2 = msg.match(/'([^']+)' column/i);
    if (m2 && payload[m2[1]] !== undefined) {
      delete payload[m2[1]];
      continue;
    }
    throw error;
  }
  return false;
}

async function insertChatMessage(sessionId, userKey, role, content) {
  await initDbMaps();
  if (!supabase || !DB.messages || !DB.sessions) return;

  const s = await getSessionRow(sessionId);
  if (!s || s[DB.sessions.cols.user] !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const c = DB.messages.cols;
  const row = {};
  row[c.sid] = sessionId;
  row[c.role] = role;
  row[c.content] = content;

  const { error } = await supabase.from(DB.messages.table).insert([row]);
  if (error) throw error;
}

async function touchSessionLastMessage(sessionId, userKey, previewText) {
  await initDbMaps();
  if (!supabase || !DB.sessions) return;

  const c = DB.sessions.cols;
  const s = await getSessionRow(sessionId);
  if (!s || s[c.user] !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const now = new Date().toISOString();
  const preview = String(previewText || "").slice(0, 200);

  const updates = {};
  updates[c.lastSeen] = now;
  updates[c.lastMsgAt] = now;
  updates[c.lastPreview] = preview;

  await safeUpdate(DB.sessions.table, c.sid, sessionId, updates);
}

async function ensureSession(sessionId, userKey) {
  await initDbMaps();
  if (!supabase || !DB.sessions) return;

  const c = DB.sessions.cols;
  const now = new Date().toISOString();

  const existing = await getSessionRow(sessionId);
  if (!existing) {
    const nextNum = await getNextConversationNumber(userKey);

    const row = {};
    row[c.sid] = sessionId;
    row[c.user] = userKey;
    row[c.lastSeen] = now;

    if (typeof nextNum === "number") row[c.conv] = nextNum;

    // Inserta (si falla por columna conv, reintenta sin conv)
    let ins = await supabase.from(DB.sessions.table).insert([row]);
    if (ins.error && isMissingColumn(ins.error)) {
      delete row[c.conv];
      ins = await supabase.from(DB.sessions.table).insert([row]);
    }
    if (ins.error) throw ins.error;

    // saludo inicial
    await insertChatMessage(sessionId, userKey, "bot", menuOpcionesTexto());
    await touchSessionLastMessage(sessionId, userKey, "Conversación nueva");
    return;
  }

  if (existing[c.user] !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const updates = {};
  updates[c.lastSeen] = now;
  await safeUpdate(DB.sessions.table, c.sid, sessionId, updates);
}

async function setPinned(sessionId, userKey, pinned) {
  await initDbMaps();
  if (!supabase || !DB.sessions) return;

  const c = DB.sessions.cols;
  const s = await getSessionRow(sessionId);
  if (!s || s[c.user] !== userKey) {
    const e = new Error("No autorizado: sesión no pertenece a este usuario.");
    e.status = 403;
    throw e;
  }

  const now = new Date().toISOString();
  const updates = {};
  updates[c.pinned] = !!pinned;
  updates[c.pinnedAt] = pinned ? now : null;

  try {
    await safeUpdate(DB.sessions.table, c.sid, sessionId, updates);
  } catch (e) {
    // si no hay columnas, avisamos
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes("pinned") || msg.includes("fijado")) {
      const err = new Error("Tu tabla de sesiones no tiene columnas de PIN.");
      err.status = 400;
      throw err;
    }
    throw e;
  }
}

async function saveSchedule(userKey, sessionId, data) {
  await initDbMaps();
  if (!supabase || !DB.schedule) return { ok: false, id: null };

  const c = DB.schedule.cols;

  // Inserción según modo
  const row = {};
  row[c.user] = userKey;
  row[c.sid] = sessionId;

  if (DB.scheduleMode === "split") {
    row[c.franja] = data.franja;
    row[c.dias] = data.dias;
  } else {
    row[c.preferencia] = JSON.stringify({ franja: data.franja, dias: data.dias });
  }

  // Pedimos id si existe
  let q = supabase.from(DB.schedule.table).insert([row]);
  if (c.id) q = q.select(c.id).maybeSingle();

  const { data: insData, error } = await q;
  if (error) throw error;

  const insertedId = insData ? insData[c.id] : null;
  if (insertedId) lastScheduleId.set(sessionId, insertedId);

  return { ok: true, id: insertedId };
}

async function getLatestSchedulePrefId(userKey, sessionId) {
  await initDbMaps();
  if (!supabase || !DB.schedule) return null;

  const c = DB.schedule.cols;
  const orderCol = c.created || "created_at";

  const { data, error } = await supabase
    .from(DB.schedule.table)
    .select(c.id)
    .eq(c.user, userKey)
    .eq(c.sid, sessionId)
    .order(orderCol, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data ? data[c.id] : null;
}

async function saveLead(userKey, sessionId, data, schedulePrefId = null) {
  await initDbMaps();
  if (!supabase || !DB.leads) return;

  const c = DB.leads.cols;

  const row = {};
  row[c.user] = userKey;
  row[c.sid] = sessionId;
  row[c.nombre] = data.nombre;
  row[c.whatsapp] = data.whatsapp;
  row[c.curso] = data.curso;

  if (schedulePrefId && c.scheduleId) row[c.scheduleId] = schedulePrefId;

  // Intento con schedule_pref_id, si falla por columna, reintenta sin ella
  let r = await supabase.from(DB.leads.table).insert([row]);
  if (r.error && isMissingColumn(r.error)) {
    if (c.scheduleId) delete row[c.scheduleId];
    r = await supabase.from(DB.leads.table).insert([row]);
  }
  if (r.error) throw r.error;
}

// ============================
// Certificado (consulta)
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
  await initDbMaps();
  if (!supabase || !DB.cert) return null;

  const c = DB.cert.cols;

  const { data, error } = await supabase
    .from(DB.cert.table)
    .select(`${c.estado}, ${c.updated}, ${c.curso}`)
    .eq(c.cedula, cedula)
    .ilike(c.curso, `%${curso}%`)
    .order(c.updated, { ascending: false })
    .limit(1);

  if (error) return null;
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
  // Soporta distintos nombres de columnas
  const estado = normalizeText(row.estado || "");
  const updated = humanDateEC(row.updated_at || row.actualizado_en || row.updated_at || row.updated || row.updated_at);
  const curso = row.curso || row.curso_nombre || row.curso;

  if (estado === "listo") {
    return `✅ CERTIFICADO LISTO

Curso: ${curso}
Actualizado: ${updated}

Si aún no lo recibiste, contáctanos:
📱 0983222358
✉️ info@fundacioncapacitamente.com`;
  }

  if (estado === "en_proceso") {
    return `⏳ CERTIFICADO EN PROCESO

Curso: ${curso}
Actualizado: ${updated}

Sugerencia: vuelve a consultar más tarde.`;
  }

  if (estado === "no_listo") {
    return `⚠️ CERTIFICADO AÚN NO LISTO

Curso: ${curso}
Actualizado: ${updated}

Si necesitas ayuda, contáctanos:
📱 0983222358
✉️ info@fundacioncapacitamente.com`;
  }

  return `📄 ESTADO DE CERTIFICADO

Curso: ${curso}
Estado: ${row.estado}
Actualizado: ${updated}`;
}

// ============================
// Leads helpers
// ============================
function extractWhatsapp(text) {
  const raw = String(text || "").replace(/\s+/g, "");
  const m = raw.match(/(\+?\d{9,15})/);
  return m ? m[1] : "";
}

function pickCourseFromText(userMessage) {
  const t = normalizeText(userMessage);

  // Por número
  if (t === "1" || t === "2" || t === "3") {
    const found = COURSE_OPTIONS.find(o => o.key === t);
    return found ? found.name : "";
  }

  // Por nombre
  for (const opt of COURSE_OPTIONS) {
    const n = normalizeText(opt.name);
    if (t.includes(n) || n.includes(t)) return opt.name;
  }

  // match suave
  if (t.includes("formador")) return "Formador de Formadores";
  if (t.includes("emocional")) return "Inteligencia Emocional";
  if (t.includes("padres")) return "Tecnología para Padres";

  return "";
}

// ============================
// IA en memoria + límites
// ============================
const sessionsAI = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 300;

const MAX_DAILY_AI_CALLS = Number(process.env.MAX_DAILY_AI_CALLS || 50);
let aiCallsToday = 0;
let aiCallsDayKey = getDayKeyEC();

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
function canUseAI() { resetDailyIfNeeded(); return aiCallsToday < MAX_DAILY_AI_CALLS; }
function incAI() { resetDailyIfNeeded(); aiCallsToday++; }

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessionsAI.entries()) {
    if (now - s.lastAccess > SESSION_TTL_MS) sessionsAI.delete(sid);
  }
  if (sessionsAI.size > MAX_SESSIONS) {
    const ordered = [...sessionsAI.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const extra = sessionsAI.size - MAX_SESSIONS;
    for (let i = 0; i < extra; i++) sessionsAI.delete(ordered[i][0]);
  }
}, 60 * 1000);

// ============================
// Routes
// ============================
app.get("/health", (req, res) => res.status(200).send("ok"));

// Lista sesiones (normaliza campos para el HTML)
app.get("/sessions", async (req, res) => {
  try {
    await initDbMaps();
    if (!supabase || !DB.sessions) return sendJson(res, { sessions: [] }, 200);

    const userKey = getUserKey(req);
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const c = DB.sessions.cols;

    // pedimos lo que exista (si falta una columna, safeUpdate no aplica aquí, pero hacemos select básico)
    const fields = [c.sid, c.created, c.lastSeen, c.lastMsgAt, c.lastPreview, c.conv, c.pinned, c.pinnedAt].filter(Boolean).join(", ");

    let q = supabase.from(DB.sessions.table).select(fields).eq(c.user, userKey);

    // Ordena fijadas primero si existe
    q = q
      .order(c.pinned, { ascending: false, nullsFirst: false })
      .order(c.pinnedAt, { ascending: false, nullsFirst: false })
      .order(c.lastMsgAt, { ascending: false, nullsFirst: false })
      .order(c.created, { ascending: false })
      .limit(limit);

    const { data, error } = await q;
    if (error) return sendJson(res, { sessions: [] }, 200);

    // Normaliza a lo que el HTML espera
    const out = (data || []).map(r => ({
      session_id: r[c.sid],
      created_at: r[c.created] || null,
      last_seen: r[c.lastSeen] || null,
      last_message_at: r[c.lastMsgAt] || null,
      last_message_preview: r[c.lastPreview] || null,
      conversation_number: typeof r[c.conv] === "number" ? r[c.conv] : null,
      pinned: !!r[c.pinned],
      pinned_at: r[c.pinnedAt] || null,
    }));

    return sendJson(res, { sessions: out }, 200);
  } catch (e) {
    return sendJson(res, { sessions: [] }, 200);
  }
});

// Crear nueva conversación
app.post("/sessions", async (req, res) => {
  try {
    const userKey = getUserKey(req);
    const sessionId = newSessionId();

    if (supabase) await ensureSession(sessionId, userKey);
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

    await setPinned(sessionId, userKey, pinned);
    return sendJson(res, { ok: true, sessionId, pinned }, 200);
  } catch (e) {
    const status = extractStatus(e) || 400;
    return sendJson(res, { error: "Error en pin", details: String(e?.message || e) }, status);
  }
});

// Eliminar conversación
app.delete("/session/:sessionId", async (req, res) => {
  try {
    await initDbMaps();
    if (!supabase || !DB.sessions || !DB.messages) return sendJson(res, { error: "Supabase/Tablas no configuradas." }, 500);

    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return sendJson(res, { error: "Falta sessionId" }, 400);

    const userKey = getUserKey(req);
    const s = await getSessionRow(sessionId);
    if (!s) return sendJson(res, { error: "Sesión no encontrada." }, 404);

    const sc = DB.sessions.cols;
    if (s[sc.user] !== userKey) return sendJson(res, { error: "No autorizado." }, 403);

    // borrar mensajes
    const mc = DB.messages.cols;
    const { error: mErr } = await supabase.from(DB.messages.table).delete().eq(mc.sid, sessionId);
    if (mErr) return sendJson(res, { error: "Error borrando mensajes", details: mErr.message }, 500);

    // borrar sesión
    const { error: dErr } = await supabase.from(DB.sessions.table).delete().eq(sc.sid, sessionId);
    if (dErr) return sendJson(res, { error: "Error borrando sesión", details: dErr.message }, 500);

    sessionsAI.delete(sessionId);
    resetFlows(sessionId);

    return sendJson(res, { ok: true, sessionId }, 200);
  } catch (e) {
    return sendJson(res, { error: "Error interno", details: String(e?.message || e) }, 500);
  }
});

// Historial
app.get("/history/:sessionId", async (req, res) => {
  try {
    await initDbMaps();
    if (!supabase || !DB.sessions || !DB.messages) return sendJson(res, { sessionId: "", messages: [] }, 200);

    const userKey = getUserKey(req);
    const sessionId = String(req.params.sessionId || "").trim();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const s = await getSessionRow(sessionId);
    const sc = DB.sessions.cols;
    if (!s || s[sc.user] !== userKey) return sendJson(res, { sessionId, messages: [] }, 200);

    const mc = DB.messages.cols;

    const { data, error } = await supabase
      .from(DB.messages.table)
      .select(`${mc.role} as role, ${mc.content} as content, ${mc.created} as created_at`)
      .eq(mc.sid, sessionId)
      .order(mc.created, { ascending: true })
      .limit(limit);

    if (error) return sendJson(res, { sessionId, messages: [] }, 200);

    return sendJson(res, { sessionId, messages: data || [] }, 200);
  } catch (e) {
    return sendJson(res, { sessionId: "", messages: [] }, 200);
  }
});

// ============================
// Chat principal
// ============================
app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message || "").trim();
    let sessionId = String(req.body?.sessionId || "").trim();

    if (!userMessage) return sendJson(res, { reply: menuOpcionesTexto(), sessionId: sessionId || newSessionId(), suggestions: suggestionsMenu() }, 200);
    if (!sessionId) sessionId = newSessionId();

    const userKey = getUserKey(req);

    // sesión
    if (supabase) await ensureSession(sessionId, userKey);

    // guardar msg usuario
    if (supabase) {
      await insertChatMessage(sessionId, userKey, "user", userMessage);
      await touchSessionLastMessage(sessionId, userKey, userMessage);
    }

    const t = normalizeText(userMessage);

    // ===== Global: saludo/menu
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

    // ===== Beneficios (SIN IA) - para evitar respuestas raras o vacías
    if (t.includes("beneficio") || (t.includes("empresa") && (t.includes("ayuda") || t.includes("beneficio")))) {
      const reply = beneficiosTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // ===== Certificarme (SIN IA) -> inscripción con selección de curso
    if ((t.includes("certificar") || t.includes("certificarme") || t.includes("certificacion")) && (t.includes("como") || t.includes("quiero"))) {
      resetFlows(sessionId);
      leadFlow.set(sessionId, { step: "curso", data: { curso: "", nombre: "", whatsapp: "" }, needSchedule: true });

      const reply = certificarTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCoursePick() }, 200);
    }

    // ===== menú por número
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
        certFlow.set(sessionId, {});
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

    // ===== disparadores
    if (t.includes("inscrib") || t.includes("inscripcion") || t === "inscribirme") {
      resetFlows(sessionId);
      leadFlow.set(sessionId, { step: "curso", data: { curso: "", nombre: "", whatsapp: "" }, needSchedule: true });

      const reply = `📝 INSCRIPCIÓN (para certificarte)

📌 Elige el curso que deseas:`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsCoursePick() }, 200);
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

    if (t.includes("precio") || t.includes("costo") || (t.includes("curso") && (t.includes("pago") || t.includes("certificado")))) {
      const reply = cursosCertTexto();
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsAfterInfo() }, 200);
    }

    // ===== FLUJO CERTIFICADO (estado)
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
      const row = await getCertificateStatus(cedula, curso);
      if (!row) {
        reply = `No encuentro un registro para:
• Cédula: ${cedula}
• Curso: ${curso}

Si crees que es un error, contáctanos:
📱 0983222358
✉️ info@fundacioncapacitamente.com`;
      } else {
        reply = certificateReplyFromRow(row);
      }

      certFlow.delete(sessionId);

      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // ===== FLUJO INSCRIPCIÓN (curso -> nombre -> whatsapp -> horario si falta -> guardar)
    if (leadFlow.has(sessionId)) {
      const st = leadFlow.get(sessionId);

      // 1) curso
      if (st.step === "curso") {
        const curso = pickCourseFromText(userMessage);
        if (!curso) {
          const reply = `📌 Elige tu curso (puedes responder con 1, 2, 3 o el nombre):

1) Formador de Formadores
2) Inteligencia Emocional
3) Tecnología para Padres`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsCoursePick() }, 200);
        }

        st.data.curso = curso;
        st.step = "nombre";
        leadFlow.set(sessionId, st);

        const reply = `✅ Curso elegido: ${curso}

Ahora dime tu NOMBRE y APELLIDO.`;
        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: [{ text: "cancelar", label: "✖ Cancelar" }, { text: "menu", label: "📌 Menú" }] }, 200);
      }

      // 2) nombre
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
        return sendJson(res, { reply, sessionId, suggestions: [{ text: "cancelar", label: "✖ Cancelar" }, { text: "menu", label: "📌 Menú" }] }, 200);
      }

      // 3) whatsapp
      if (st.step === "whatsapp") {
        const w = extractWhatsapp(userMessage);
        if (!w) {
          const reply = `No pude leer el número 😅
Escríbelo así: +593991112233 o 0991112233`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: [{ text: "cancelar", label: "✖ Cancelar" }, { text: "menu", label: "📌 Menú" }] }, 200);
        }

        st.data.whatsapp = w;

        // Si ya hay horario guardado en esta sesión, guardamos lead ya mismo
        let schedId = lastScheduleId.get(sessionId);
        if (!schedId) {
          schedId = await getLatestSchedulePrefId(userKey, sessionId);
        }

        if (!schedId && st.needSchedule) {
          // pedimos horario y luego guardamos
          st.step = "await_schedule";
          leadFlow.set(sessionId, st);

          scheduleFlow.set(sessionId, { step: "franja", data: {} });

          const reply = `✅ Perfecto.

Antes de finalizar, dime tu HORARIO preferido para las clases online:
• Mañana
• Tarde
• Noche`;
          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsScheduleFlowStep1() }, 200);
        }

        // Guardar lead
        try {
          await saveLead(userKey, sessionId, st.data, schedId || null);
        } catch (e) {
          console.warn("⚠️ No se pudo guardar lead:", extractMessage(e));
        }

        leadFlow.delete(sessionId);

        const reply = `✅ ¡Listo! Inscripción registrada.

Curso: ${st.data.curso}
Nombre: ${st.data.nombre}
WhatsApp: ${st.data.whatsapp}

En breve te contactaremos por WhatsApp para ayudarte con tu certificación.
Escribe MENU para ver opciones.`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
      }

      // await_schedule se resuelve cuando termina scheduleFlow
    }

    // ===== FLUJO HORARIO
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

        let schedId = null;
        try {
          const saved = await saveSchedule(userKey, sessionId, st.data);
          schedId = saved.id;
        } catch (e) {
          console.warn("⚠️ No se pudo guardar horario:", extractMessage(e));
        }

        scheduleFlow.delete(sessionId);

        // Si hay inscripción esperando horario, la guardamos ahora
        if (leadFlow.has(sessionId) && leadFlow.get(sessionId).step === "await_schedule") {
          const lf = leadFlow.get(sessionId);
          const prefId = schedId || lastScheduleId.get(sessionId) || null;

          try {
            await saveLead(userKey, sessionId, lf.data, prefId);
          } catch (e) {
            console.warn("⚠️ No se pudo guardar lead post-horario:", extractMessage(e));
          }

          leadFlow.delete(sessionId);

          const reply = `✅ ¡Perfecto! Guardé tu horario y tu inscripción.

Horario: ${st.data.franja} | ${st.data.dias}
Curso: ${lf.data.curso}
Nombre: ${lf.data.nombre}
WhatsApp: ${lf.data.whatsapp}

En breve te contactaremos por WhatsApp.`;

          if (supabase) {
            await insertChatMessage(sessionId, userKey, "bot", reply);
            await touchSessionLastMessage(sessionId, userKey, reply);
          }
          return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
        }

        // Si NO hay inscripción esperando, ofrecemos inscribirse
        const reply = `✅ ¡Gracias! Guardé tu preferencia de horario.

Franja: ${st.data.franja}
Días: ${st.data.dias}

¿Deseas inscribirte ahora para certificarte?`;

        if (supabase) {
          await insertChatMessage(sessionId, userKey, "bot", reply);
          await touchSessionLastMessage(sessionId, userKey, reply);
        }
        return sendJson(res, { reply, sessionId, suggestions: suggestionsPostScheduleCTA() }, 200);
      }
    }

    // ============================
    // IA (solo si existe y no cayó en nada)
    // ============================
    if (!ai) {
      const reply = `Estoy listo para ayudarte con la Fundación Capacítamente.

${menuOpcionesTexto()}`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    if (!canUseAI()) {
      const reply = `Por ahora usaré el menú para ayudarte con la Fundación Capacítamente.

${menuOpcionesTexto()}`;
      if (supabase) {
        await insertChatMessage(sessionId, userKey, "bot", reply);
        await touchSessionLastMessage(sessionId, userKey, reply);
      }
      return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
    }

    // IA con retry suave
    let session = sessionsAI.get(sessionId);
    if (!session) {
      const chat = ai.chats.create({
        model: GEMINI_MODEL,
        config: { systemInstruction, temperature: 0.3, maxOutputTokens: 500 },
      });
      session = { chat, lastAccess: Date.now() };
      sessionsAI.set(sessionId, session);
    } else {
      session.lastAccess = Date.now();
    }

    incAI();

    let reply = "";
    try {
      const response = await session.chat.sendMessage({ message: userMessage });
      reply = typeof response.text === "string" ? response.text.trim() : "";
    } catch {
      reply = "";
    }

    if (!reply) {
      // Fallback “sin error”
      reply = `Puedo ayudarte con la Fundación Capacítamente.

${menuOpcionesTexto()}`;
    }

    if (supabase) {
      await insertChatMessage(sessionId, userKey, "bot", reply);
      await touchSessionLastMessage(sessionId, userKey, reply);
    }

    return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
  } catch (error) {
    // En tesis: devolvemos SIEMPRE algo útil (no "error interno") para evitar pantallas feas
    const sessionId = String(req.body?.sessionId || "").trim() || newSessionId();
    const reply = `Puedo ayudarte con la Fundación Capacítamente.

${menuOpcionesTexto()}`;
    return sendJson(res, { reply, sessionId, suggestions: suggestionsMenu() }, 200);
  }
});

app.listen(port, "0.0.0.0", async () => {
  console.log(`✅ Servidor escuchando en puerto ${port}`);
  try { await initDbMaps(); } catch {}
});

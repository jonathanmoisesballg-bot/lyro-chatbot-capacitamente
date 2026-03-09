const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isScholarshipQuery,
  isCourseDifferenceQuery,
  isApprovalCriteriaQuery,
  isInstructorQuery,
  isStoreQuery,
  isAccountRegistrationQuery,
  buildGuidedFallbackForFoundation,
} = require("../server");

test("detecta becas", () => {
  assert.equal(isScholarshipQuery("quiero una beca"), true);
  assert.equal(isScholarshipQuery("hay becas?"), true);
});

test("detecta diferencia cursos gratis vs certificados", () => {
  assert.equal(isCourseDifferenceQuery("diferencia curso gratuito vs certificado"), true);
  assert.equal(isCourseDifferenceQuery("gratis o certificado"), true);
});

test("detecta aprobacion con frases naturales", () => {
  assert.equal(isApprovalCriteriaQuery("con cuanto apruebo"), true);
  assert.equal(isApprovalCriteriaQuery("requisitos de fundacion"), true);
});

test("detecta formar parte como instructor/docente/maestro", () => {
  assert.equal(isInstructorQuery("quiero ser maestro en la fundacion"), true);
  assert.equal(isInstructorQuery("quiero ser docente"), true);
});

test("detecta tienda solidaria y crear cuenta", () => {
  assert.equal(isStoreQuery("donde esta la tienda solidaria"), true);
  assert.equal(isAccountRegistrationQuery("como crear cuenta"), true);
});

test("fallback guiado para mensajes de fundacion no mapeados", () => {
  const out = buildGuidedFallbackForFoundation("tengo dudas de cursos y becas");
  assert.ok(out);
  assert.ok(String(out.reply).includes("ruta directa"));
  assert.ok(Array.isArray(out.suggestions));
  assert.ok(out.suggestions.length >= 4);
});

test("fallback guiado no se activa para temas fuera de fundacion", () => {
  const out = buildGuidedFallbackForFoundation("cuanto mide la torre eiffel");
  assert.equal(out, null);
});

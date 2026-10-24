// Executable regression tests for knowledge-first economics, source applicability, and grounding safety.
// Run: node website/tests/knowledge-first-routing.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/clever-handler/index.ts'), 'utf8');
const spec = fs.readFileSync(path.join(root, 'docs/approved-pricing-and-entitlements-2026-10-24.md'), 'utf8');
const criteria = fs.readFileSync(path.join(root, 'docs/learning-loop-quality-and-margin-acceptance-criteria-2026-10-24.md'), 'utf8');

// 1. Extract production routing helpers directly from Edge handler and execute in Node VM
const begin = source.indexOf('function normalizedEquipmentReference(');
const end = source.indexOf('function boundedPositiveLimit(', begin);
assert.ok(begin > 0 && end > begin, 'knowledge routing helpers must exist in the Edge handler');
let helperSource = source.slice(begin, end);

// Strip TS annotations for Node vm
helperSource = helperSource.replace(/\):\s*(?:string\[\]|string|boolean|number|\{[^}]+\})\s*\{/g, ') {');
helperSource = helperSource.replace(/:\s*(?:AnyRecord\[\]|string\[\]|AnyRecord|string|boolean|number|unknown)(?:\s*\|\s*(?:null|undefined))*/g, '');
helperSource = helperSource.replace(/\bas\s+[^;,\n)]+/g, '');

const context = {
  getProcedureText: row => String(row.procedure_text ?? row.content_text ?? ''),
  isCriticalPoolHazardText: text => /\b(gas leak|smell gas|chlorine gas|poisonous gas|explosion risk|electrocution risk)\b/i.test(text),
  textValue: (val, len) => String(val ?? '').slice(0, len),
};
vm.createContext(context);
vm.runInContext(helperSource, context);

const eligible = context.preferVerifiedInternalOnly;
const matches = context.referenceMatchesEquipment;
const verifyCitation = context.verifyInternalCitation;
const symptomMatches = context.symptomMatchesProcedure;

assert.equal(typeof eligible, 'function');
assert.equal(typeof matches, 'function');
assert.equal(typeof verifyCitation, 'function');
assert.equal(typeof symptomMatches, 'function');

// 2. Base test fixtures
const validPentairLesson = {
  id: 'kb-pt-vsf-001',
  shared_learning_source: true,
  brand: 'Pentair',
  model_family: 'IntelliFlo VSF',
  category: 'pump',
  symptom: 'Pump motor will not start, display is dead, breaker trips on power up',
  procedure_text: 'Inspect drive electronics and AC input voltage. Check breaker sizing. If display is dark and breaker trips immediately, inspect drive module for short circuit and verify power wiring. '.repeat(2),
};

const impellerCleaningLesson = {
  id: 'kb-pt-vsf-002',
  shared_learning_source: true,
  brand: 'Pentair',
  model_family: 'IntelliFlo VSF',
  category: 'pump',
  symptom: 'Impeller clogged with pine needles, reduced water flow',
  procedure_text: 'Pump motor impeller cleaning: remove debris from clogged impeller, clean pump strainer basket with garden hose, and reassemble wet end assembly. '.repeat(2),
};

const validRaypakLesson = {
  id: 'kb-rp-406a-001',
  shared_learning_source: true,
  brand: 'Raypak',
  model_family: '406A',
  category: 'heater',
  symptom: 'Heater displays fault code BD1 board failure and will not ignite',
  procedure_text: 'Fault code BD1 indicates internal circuit board failure. Check 24VAC transformer output and inspect control board for scorched traces or moisture intrusion. Replace board if supply voltage is nominal. '.repeat(2),
};

const heaterCabinetLesson = {
  id: 'kb-rp-406a-002',
  shared_learning_source: true,
  brand: 'Raypak',
  model_family: '406A',
  category: 'heater',
  symptom: 'Heater cabinet door latch loose and exterior rust spot',
  procedure_text: 'Inspect heater cabinet exterior jacket panels and lubricate latch mechanism. Clean cabinet surface with gentle detergent. '.repeat(2),
};

// 3. Positive verification: exact make/model AND matching symptom/error code
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VSF', 'Pump won\'t start, display is dead', 'pump'),
  true,
  'confirmed exact make/model + matching symptom suppresses initial paid search'
);

assert.equal(
  eligible([validRaypakLesson], 'Raypak', '406A', 'fault code BD1 board issue', 'heater', 'BD1'),
  true,
  'confirmed exact heater lesson with matching error code BD1 suppresses initial search'
);

// 4. P0-4 Negative verification: Exact negative tests for dangerous symptom false positives
// A) Pump won't start query vs Impeller cleaning procedure on exact same Pentair VSF model
assert.equal(
  eligible([impellerCleaningLesson], 'Pentair', 'IntelliFlo VSF', 'pump won\'t start', 'pump'),
  false,
  'CRITICAL P0-4: pump won\'t start query MUST NOT be suppressed by an impeller cleaning procedure on the same model'
);
assert.equal(
  symptomMatches(impellerCleaningLesson.procedure_text, impellerCleaningLesson.symptom, 'pump won\'t start', 'pump'),
  false,
  'impeller cleaning procedure must not match silent no-start complaint'
);

// B) Heater won't ignite query vs Cabinet maintenance procedure on exact same Raypak 406A model
assert.equal(
  eligible([heaterCabinetLesson], 'Raypak', '406A', 'heater won\'t ignite', 'heater'),
  false,
  'CRITICAL P0-4: heater won\'t ignite query MUST NOT be suppressed by cabinet maintenance on the same model'
);
assert.equal(
  symptomMatches(heaterCabinetLesson.procedure_text, heaterCabinetLesson.symptom, 'heater won\'t ignite', 'heater'),
  false,
  'cabinet maintenance procedure must not match ignition complaint'
);

// C) Generic query without useful symptom tokens (e.g. "Hayward pump") must NOT match arbitrary manuals
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VSF', 'Pentair pump', 'pump'),
  false,
  'query without actionable diagnostic symptom tokens must retain search/clarification'
);

// D) Shaft seal water leak query vs electrical no-start
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VSF', 'Shaft seal leaking water onto pad', 'pump'),
  false,
  'shaft seal water leak query must NOT be suppressed by an electrical start lesson'
);

// 5. Negative verification: Error code mismatch rejection
assert.equal(
  eligible([validRaypakLesson], 'Raypak', '406A', 'rollout switch open error ROL', 'heater', 'ROL'),
  false,
  'error code mismatch (ROL rollout switch vs BD1 board failure) MUST retain web search'
);

// 6. Negative verification: Critical safety hazards must NEVER suppress search or caution
assert.equal(
  eligible([validRaypakLesson], 'Raypak', '406A', 'strong gas leak smell around heater cabinet', 'heater'),
  false,
  'critical pool hazard (gas leak) must NEVER suppress external verification or safety stop'
);

// 7. Negative verification: Missing or invalid server evidence ID
assert.equal(
  eligible([{ ...validPentairLesson, id: null }], 'Pentair', 'IntelliFlo VSF', 'Pump won\'t start, display is dead', 'pump'),
  false,
  'internal lesson without server-confirmed evidence ID must NOT suppress search'
);

// 8. Negative verification: Low-information text (< 80 chars)
assert.equal(
  eligible([{ ...validPentairLesson, procedure_text: 'Check power switch and breaker.' }], 'Pentair', 'IntelliFlo VSF', 'Pump won\'t start', 'pump'),
  false,
  'low-information procedure (< 80 chars) must NOT suppress search'
);

// 9. Negative verification: Category mismatch
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VSF', 'Pump won\'t start, display is dead', 'heater'),
  false,
  'conflicting equipment category must NOT suppress search'
);

// 10. Negative verification: Make/Model boundaries
assert.equal(
  eligible([validPentairLesson], 'Hayward', 'IntelliFlo VSF', 'Pump won\'t start, display is dead', 'pump'),
  false,
  'brand mismatch must retain search'
);
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VS', 'Pump won\'t start, display is dead', 'pump'),
  false,
  'model family variation (VS vs VSF) must retain search'
);

// 11. Server-side citation validation (P0-3: Corroboration and anti-hallucination)
// Case A: Model claims internal_manual and step substantively corroborates server KB row -> verified
const validCitationResult = verifyCitation(
  {
    source_label: 'internal_manual',
    source_id: 'kb-pt-vsf-001',
    step: 'Inspect drive electronics and AC line voltage input to check if drive module has short circuit.'
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(validCitationResult.verified, true);
assert.equal(validCitationResult.sourceKind, 'approved_lesson');
assert.equal(validCitationResult.sourceId, 'kb-pt-vsf-001');

// Case B: Model self-attests internal_manual, but NO server KB row matches -> rejected!
const hallucinatedCitationResult = verifyCitation(
  { source_label: 'internal_manual', step: 'Replace impeller and seals.' },
  [],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(hallucinatedCitationResult.verified, false, 'unsubstantiated model citation must be rejected server-side');
assert.equal(hallucinatedCitationResult.sourceKind, 'none');

// Case C: Model self-attests internal_manual with an invented step that does NOT corroborate the KB row
const inventedStepResult = verifyCitation(
  {
    source_label: 'internal_manual',
    step: 'Pour 5 gallons of muriatic acid directly into the skimmer basket while pump is off.'
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(inventedStepResult.verified, false, 'invented step without corroboration in KB procedure must be rejected');

// Case D: Stale / unapproved lesson (approved_for_learning === false) must be rejected
const staleLessonResult = verifyCitation(
  { source_label: 'internal_manual', source_id: 'kb-stale-001', step: 'Inspect drive electronics.' },
  [{ ...validPentairLesson, id: 'kb-stale-001', approved_for_learning: false }],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(staleLessonResult.verified, false, 'stale/unapproved lesson must not pass citation verification');

// 12. P0-1 & P0-2: Full-handler structural wiring assertions
// P0-1: Check that verifyInternalCitation is called with structuredResponse (null-safe), NOT bare structured!
assert.match(source, /verifyInternalCitation\(structuredResponse,\s*kbRows,\s*brand,\s*model/);
assert.doesNotMatch(source, /verifyInternalCitation\(structured,\s*kbRows/);

// P0-2: Water-chemistry source self-attestation bypass removed!
assert.match(source, /relevantWaterQualityProcedurePresent && internalCitation\.verified/);
assert.doesNotMatch(source, /relevantWaterQualityProcedurePresent && \(internalCitation\.verified \|\| structuredSourceLabel === "internal_manual"\)/);

// P1-8: SourceMode union type safety
assert.match(source, /sourceMode = "manual"/);
assert.match(source, /let sourceKind:\s*"company_sop" \| "approved_lesson" \| "manufacturer_web" \| "none"/);

// Unverified case quarantine & consent invariants
assert.match(source, /if \(row\.technician_verified && caseOptIn\) \{/,
  'technician jobs must have explicit case consent to enter review queue');
assert.match(source, /case_learning_opt_in:\s*caseOptIn/,
  'save_technician_job properly persists case_learning_opt_in on diagnostic_cases');
assert.match(source, /code: "VERIFIED_REPAIR_REQUIRED"/,
  'unresolved technician lessons cannot pass shared-knowledge approval');
assert.match(source, /caseRow\?\.case_learning_opt_in === true/,
  'case-level dual consent mandatory for shared learning');

// 13. Commercial policy & price stability invariants
assert.match(spec, /\$39 \| 1 \| 50/);
assert.match(spec, /\$75 \| 2 \| 150/);
assert.match(spec, /\$149 \| 6 \| 400/);
assert.match(spec, /\$269 \| 15 \| 800/);
assert.match(spec, /\$59 \| 1 \| 80/);
assert.match(spec, /\$109 \| 2 \| 200/);
assert.match(spec, /\$199 \| 6 \| 500/);
assert.match(spec, /\$369 \| 15 \| 1000/);
assert.ok(spec.includes('+$19 per added active seat per month'));
assert.match(spec, /subscription prices are not automatically reduced as internal diagnostic costs fall/i);
assert.match(criteria, /approved public subscription prices remain in force/i);
assert.match(criteria, /raise (?:\*\*)?gross\/contribution margin(?:\*\*)?, not reduce prices/i);

console.log('PASS: all Part-2 knowledge-first routing, dangerous false-positive gating, server citation corroboration, and fixed-price margin tests succeeded.');

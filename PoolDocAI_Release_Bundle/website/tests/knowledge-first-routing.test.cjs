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
helperSource = helperSource.replace(/:\s*(?:AnyRecord\[\]|string\[\]|AnyRecord|string|boolean|number|unknown)/g, '');

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

assert.equal(typeof eligible, 'function');
assert.equal(typeof matches, 'function');
assert.equal(typeof verifyCitation, 'function');

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

const validRaypakLesson = {
  id: 'kb-rp-406a-001',
  shared_learning_source: true,
  brand: 'Raypak',
  model_family: '406A',
  category: 'heater',
  symptom: 'Heater displays fault code BD1 board failure and will not ignite',
  procedure_text: 'Fault code BD1 indicates internal circuit board failure. Check 24VAC transformer output and inspect control board for scorched traces or moisture intrusion. Replace board if supply voltage is nominal. '.repeat(2),
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

// 4. Negative verification: P0 symptom mismatch rejection (unrelated fix on same model must NOT suppress search)
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VSF', 'Impeller clogged with pine needles, low water flow', 'pump'),
  false,
  'unrelated symptom (clogged impeller/flow vs electrical no-start) on same model MUST retain web search'
);

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
  eligible([{ ...validPentairLesson, id: null }], 'Pentair', 'IntelliFlo VSF', 'Pump won\'t start', 'pump'),
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
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VSF', 'Pump won\'t start', 'heater'),
  false,
  'conflicting equipment category must NOT suppress search'
);

// 10. Negative verification: Make/Model boundaries
assert.equal(
  eligible([validPentairLesson], 'Hayward', 'IntelliFlo VSF', 'Pump won\'t start', 'pump'),
  false,
  'brand mismatch must retain search'
);
assert.equal(
  eligible([validPentairLesson], 'Pentair', 'IntelliFlo VS', 'Pump won\'t start', 'pump'),
  false,
  'model family variation (VS vs VSF) must retain search'
);
assert.equal(
  eligible([validPentairLesson], 'Pentair', '', 'Pump won\'t start', 'pump'),
  false,
  'unknown model must retain search'
);
assert.equal(
  eligible([validPentairLesson], '', 'IntelliFlo VSF', 'Pump won\'t start', 'pump'),
  false,
  'unknown make must retain search'
);

// 11. Server-side citation validation (P0: anti-hallucination / self-citation rejection)
// Case A: Model claims internal_manual and matching server KB row exists -> verified
const validCitationResult = verifyCitation(
  { source_label: 'internal_manual' },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(validCitationResult.verified, true);
assert.equal(validCitationResult.sourceKind, 'approved_lesson');

// Case B: Model self-attests internal_manual, but NO server KB row matches -> rejected!
const hallucinatedCitationResult = verifyCitation(
  { source_label: 'internal_manual' },
  [], // No server KB rows returned
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start'
);
assert.equal(hallucinatedCitationResult.verified, false, 'unsubstantiated model citation must be rejected server-side');
assert.equal(hallucinatedCitationResult.sourceKind, 'none');

// Case C: Model self-attests internal_manual, but KB row is for a different make/model
const mismatchedCitationResult = verifyCitation(
  { source_label: 'internal_manual' },
  [validRaypakLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start'
);
assert.equal(mismatchedCitationResult.verified, false, 'mismatched equipment citation must be rejected');

// 12. Handler structural wiring & security invariant assertions
assert.match(source, /kbRows = kbRows\.filter\(\(row\) => referenceMatchesEquipment\(row, brand, model\)\)/);
assert.match(source, /const firstPassInternalOnly = preferVerifiedInternalOnly\(kbRows, brand, model/);
assert.match(source, /const internalCitation = verifyInternalCitation\(structured, kbRows, brand, model/);
assert.match(source, /if \(!firstPassInternalOnly\) \{\s*groundingReservationId = await reserveGroundingBudget/);
assert.match(source, /tools: firstPassInternalOnly \? \[\] : \[\{ type: "google_search" \}\]/);
assert.match(source, /const shouldRunFallbackSearch = needsSourceGroundedAnswer/);
assert.match(source, /event_type: "diagnostic_source_route"/);
assert.match(source, /search_queries_attempted:/);
assert.match(source, /kb_answer_verified:/);
assert.match(source, /tenant_isolated:/);

// Unverified case quarantine & consent invariants
assert.match(source, /if \(row\.technician_verified\) \{/,
  'unresolved and unverified field jobs stay outside the shared review queue');
assert.match(source, /caseRow\?\.technician_verified !== true/,
  'review endpoint strictly rejects unverified cases from becoming shared knowledge');
assert.match(source, /code: "VERIFIED_REPAIR_REQUIRED"/,
  'proper error code returned when unverified case review is attempted');
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

console.log('PASS: all knowledge-first routing, symptom gating, server citation validation, quarantine, and fixed-price margin tests succeeded.');

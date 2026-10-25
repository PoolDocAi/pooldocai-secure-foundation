// Executable regression tests for knowledge-first economics, source applicability, and grounding safety.
// Run: node website/tests/knowledge-first-routing.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/clever-handler/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const spec = fs.readFileSync(path.join(root, 'docs/approved-pricing-and-entitlements-2026-10-24.md'), 'utf8');
const criteria = fs.readFileSync(path.join(root, 'docs/learning-loop-quality-and-margin-acceptance-criteria-2026-10-24.md'), 'utf8');

// 1. Extract production routing helpers directly from Edge handler and execute in Node VM
const begin = source.indexOf('function normalizedEquipmentReference(');
const end = source.indexOf('function boundedPositiveLimit(', begin);
assert.ok(begin > 0 && end > begin, 'knowledge routing helpers must exist in the Edge handler');
let helperSource = source.slice(begin, end);

// Strip TS annotations for Node vm
helperSource = helperSource.replace(/\):\s*(?:Array<[^>]+>|string\[\]|string|boolean|number|\{[^}]+\})\s*\{/g, ') {');
helperSource = helperSource.replace(/:\s*Array<[^>]+>/g, '');
helperSource = helperSource.replace(/:\s*RegExpExecArray\s*\|\s*null/g, '');
helperSource = helperSource.replace(/:\s*(?:AnyRecord\[\]|string\[\]|AnyRecord|string|boolean|number|unknown)(?:\s*\|\s*(?:null|undefined))*/g, '');
helperSource = helperSource.replace(/\bas\s+[^;,\n)]+/g, '');

// Extract water quality helpers from earlier in the handler
function extractFunc(name) {
  const fStart = source.indexOf(`function ${name}(`);
  assert.ok(fStart > 0, `Function ${name} must exist in clever-handler`);
  const fEnd = source.indexOf('\n}\n', fStart);
  let code = source.slice(fStart, fEnd + 3);
  code = code.replace(/\):\s*(?:boolean|string|number)\s*\{/g, ') {');
  code = code.replace(/:\s*(?:string|boolean|number|unknown)/g, '');
  return code;
}

const waterQualityFuncs = extractFunc('isRelevantWaterQualityProcedure') + '\n' + extractFunc('hasCompleteAlgaeTreatmentPlan');

const context = {
  getProcedureText: row => String(row.procedure_text ?? row.content_text ?? ''),
  isCriticalPoolHazardText: text => /\b(gas leak|smell gas|chlorine gas|poisonous gas|explosion risk|electrocution risk)\b/i.test(text),
  textValue: (val, len) => String(val ?? '').slice(0, len),
};
vm.createContext(context);
vm.runInContext(waterQualityFuncs, context);
vm.runInContext(helperSource, context);

const eligible = context.preferVerifiedInternalOnly;
const matches = context.referenceMatchesEquipment;
const verifyCitation = context.verifyInternalCitation;
const symptomMatches = context.symptomMatchesProcedure;
const isRelevantWaterQuality = context.isRelevantWaterQualityProcedure;
const hasCompleteAlgae = context.hasCompleteAlgaeTreatmentPlan;

assert.equal(typeof eligible, 'function');
assert.equal(typeof matches, 'function');
assert.equal(typeof verifyCitation, 'function');
assert.equal(typeof symptomMatches, 'function');
assert.equal(typeof isRelevantWaterQuality, 'function');
assert.equal(typeof hasCompleteAlgae, 'function');

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

const validAlgaeSOP = {
  id: 'kb-sop-algae-001',
  company_manual_source: true,
  title: 'Algae Remediation & SLAM Method SOP',
  brand: 'Generic',
  model_family: 'Water Care',
  category: 'water_quality',
  symptom: 'Pool water is green with heavy algae bloom',
  procedure_text: 'Complete algae remediation and green pool cleanup: Maintain free chlorine shock target relative to CYA stabilizer level. Thoroughly brush pool floor and walls twice daily. Run continuous filtration and circulation, backwashing when filter pressure rises 25 percent. Test free chlorine and combined chlorine every 4 hours and redose as needed. Remediation completion criteria: overnight chlorine loss under 1 ppm, combined chlorine 0.5 ppm or lower, and water is crystal clear with no visible algae.'.repeat(2)
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

// 11. Server-side citation validation (P0 A & P0 B: Realistic schema, conjunction, and safety)
// Case A: Model claims internal_manual using production response format (step_instructions) -> verified
const validCitationResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-pt-vsf-001',
    source_title: 'Pentair IntelliFlo VSF Troubleshooting',
    step_instructions: 'Inspect drive electronics and AC line voltage input to check if drive module has short circuit.',
    safety_warning: 'Ensure main circuit breaker is off before inspecting electrical connections.',
    follow_up_question: 'Is 240VAC line voltage present at the drive terminal block?'
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
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-pt-vsf-001',
    step_instructions: 'Replace impeller and seals.'
  },
  [],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(hallucinatedCitationResult.verified, false, 'unsubstantiated model citation must be rejected server-side');
assert.equal(hallucinatedCitationResult.sourceKind, 'none');

// Case C: P0 B Negative Test: Valid matching source ID with UNRELATED repair step -> must be UNVERIFIED
const unrelatedStepWithValidId = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-pt-vsf-001', // Correct valid source ID!
    source_title: 'Pentair IntelliFlo VSF Troubleshooting',
    step_instructions: 'Replace the sand filter multiport backwash valve laterals and spider gasket.' // Unrelated step!
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(unrelatedStepWithValidId.verified, false, 'P0 B: Valid source ID with unrelated repair step must fail citation verification');

// Case D: P0 B Negative Test: Valid matching source ID with UNGROUNDED chemical dosing -> must be UNVERIFIED
const ungroundedChemicalDosing = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-pt-vsf-001', // Correct valid source ID!
    step_instructions: 'Add 2 gallons of muriatic acid to the pump pot while testing voltage.'
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(ungroundedChemicalDosing.verified, false, 'P0 B: Ungrounded chemical dosing absent from procedure must fail citation verification');

// Case E: Critical pool safety hazard text in step -> must be UNVERIFIED
const hazardStepResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-pt-vsf-001',
    step_instructions: 'Bypass breaker and touch live wiring directly to test if electrocution risk occurs.'
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(hazardStepResult.verified, false, 'Hazardous action must never pass citation verification');

// Case F: Stale / unapproved lesson (approved_for_learning === false) must be rejected
const staleLessonResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-stale-001',
    step_instructions: 'Inspect drive electronics and AC input voltage.'
  },
  [{ ...validPentairLesson, id: 'kb-stale-001', approved_for_learning: false }],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(staleLessonResult.verified, false, 'stale/unapproved lesson must not pass citation verification');

// Case G: Schema-conforming Water Quality Plan response (using message field) -> verified
const validWaterPlanResult = verifyCitation(
  {
    response_type: 'water_quality_plan',
    source_label: 'internal_manual',
    source_id: 'kb-sop-algae-001',
    message: 'Algae remediation plan: 1. Maintain free chlorine shock level relative to CYA stabilizer. 2. Thoroughly brush all pool surfaces and walls twice daily. 3. Run continuous filtration and circulation, backwashing when filter pressure rises. 4. Retest free chlorine daily and redose as needed. 5. Finish criteria: clear water with zero visible algae and overnight chlorine loss under 1 ppm.',
    step_title: 'Algae Treatment Plan',
    step_instructions: '',
    safety_warning: 'Do not allow swimmers until free chlorine returns to safe levels.',
    follow_up_question: 'What is your current CYA reading?'
  },
  [validAlgaeSOP],
  'Generic',
  'Water Care',
  'Pool water is green with heavy algae bloom'
);
assert.equal(validWaterPlanResult.verified, true);
assert.equal(validWaterPlanResult.sourceKind, 'company_sop');
assert.equal(validWaterPlanResult.sourceId, 'kb-sop-algae-001');

// Case H: Incomplete water quality plan missing required treatment steps -> rejected
const incompleteWaterPlanResult = verifyCitation(
  {
    response_type: 'water_quality_plan',
    source_label: 'internal_manual',
    source_id: 'kb-sop-algae-001',
    message: 'Pour chlorine in the pool and turn on the pump.'
  },
  [validAlgaeSOP],
  'Generic',
  'Water Care',
  'Pool water is green with heavy algae bloom'
);
assert.equal(incompleteWaterPlanResult.verified, false, 'Incomplete algae plan must fail corroboration');

// Case I: P0-1 Negative Test: empty source_id and source_title with superficially overlapping text -> must fail verification
const emptySourceIdResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: '',
    source_title: '',
    step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.'
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(emptySourceIdResult.verified, false, 'P0-1: Empty source_id and source_title must fail citation verification even with overlapping advice');
assert.equal(emptySourceIdResult.sourceKind, 'none');

// Case J: P0-1 Negative Test: missing source_id property entirely -> must fail verification
const missingSourceIdResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_title: 'Pentair IntelliFlo VSF Troubleshooting',
    step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.'
  },
  [validPentairLesson],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(missingSourceIdResult.verified, false, 'P0-1: Missing source_id property must fail citation verification');

// Case K: P0-2 Negative Test: 1 oz in source manual vs 100 gallons claimed by model -> must fail verification
const chlorinationManualRow = {
  id: 'kb-chlor-sop-001',
  company_manual_source: true,
  title: 'Liquid Chlorine Dosing SOP',
  brand: 'Generic',
  model_family: 'Water Care',
  category: 'water_quality',
  symptom: 'Low free chlorine in pool water',
  procedure_text: 'For standard daily sanitation, add 1 oz of liquid chlorine per 1000 gallons of pool water to raise free chlorine 1 ppm. Test water before redosing.'.repeat(2)
};

const inventedLargeGallonsResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chlor-sop-001',
    source_title: 'Liquid Chlorine Dosing SOP',
    step_instructions: 'Add 100 gallons of liquid chlorine directly into the pool.'
  },
  [chlorinationManualRow],
  'Generic',
  'Water Care',
  'Low free chlorine in pool water'
);
assert.equal(inventedLargeGallonsResult.verified, false, 'P0-2: Invented 100 gallons vs 1 oz manual dose must fail quantitative corroboration');

// Case L: P0-2 Negative Test: 3 ppm target in procedure vs 30 ppm claimed by model -> must fail verification
const inventedPpmResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chlor-sop-001',
    source_title: 'Liquid Chlorine Dosing SOP',
    step_instructions: 'Raise free chlorine to 30 ppm immediately.'
  },
  [chlorinationManualRow],
  'Generic',
  'Water Care',
  'Low free chlorine in pool water'
);
assert.equal(inventedPpmResult.verified, false, 'P0-2: Invented 30 ppm vs 1 ppm / 3 ppm must fail quantitative corroboration');

// Case M: P0-2 Negative Test: consistent algae treatment plan + invented large chemical dose (50 lbs shock) -> must fail verification
const algaePlanWithInventedDose = verifyCitation(
  {
    response_type: 'water_quality_plan',
    source_label: 'internal_manual',
    source_id: 'kb-sop-algae-001',
    message: 'Algae remediation plan: 1. Add 50 lbs of shock to the pool. 2. Thoroughly brush all pool surfaces and walls twice daily. 3. Run continuous filtration and circulation, backwashing when filter pressure rises. 4. Retest free chlorine daily and redose as needed. 5. Finish criteria: clear water with zero visible algae and overnight chlorine loss under 1 ppm.',
    step_title: 'Algae Treatment Plan'
  },
  [validAlgaeSOP],
  'Generic',
  'Water Care',
  'Pool water is green with heavy algae bloom'
);
assert.equal(algaePlanWithInventedDose.verified, false, 'P0-2: Consistent algae plan with invented large dose (50 lbs) must fail corroboration');

// --- PART-5 CONTEXTUAL CHEMICAL GROUNDING & METRIC UNIT REGRESSION TESTS ---

// Case N: Pool volume misused as chemical product dose -> MUST FAIL
const poolVolumeMisused = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chlor-sop-001',
    source_title: 'Liquid Chlorine Dosing SOP',
    step_instructions: 'Add 10,000 gal liquid chlorine to treat the pool.'
  },
  [{
    id: 'kb-chlor-sop-001',
    company_manual_source: true,
    title: 'Liquid Chlorine Dosing SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Low free chlorine in pool water',
    procedure_text: 'For a 10,000 gal pool, dose only 1 oz of liquid chlorine per label directions. Verify water chemistry before adding additional sanitizer.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Low free chlorine in pool water'
);
assert.equal(poolVolumeMisused.verified, false, 'Case N: Pool volume (10,000 gal) misused as product dose must fail verification');

// Case O: Prohibited dose repeated as recommendation -> MUST FAIL
const prohibitedDoseRepeated = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chlor-sop-001',
    source_title: 'Liquid Chlorine Dosing SOP',
    step_instructions: 'Add 10,000 gal liquid chlorine.'
  },
  [{
    id: 'kb-chlor-sop-001',
    company_manual_source: true,
    title: 'Liquid Chlorine Dosing SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Low free chlorine in pool water',
    procedure_text: 'For a 10,000 gal pool, NEVER add 10,000 gal of chlorine; dose only 1 oz of liquid chlorine per the label. Ensure pump is circulating.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Low free chlorine in pool water'
);
assert.equal(prohibitedDoseRepeated.verified, false, 'Case O: Prohibited dose repeated as recommendation must fail verification');

// Case P: Two chemicals same number unit swapped (2 oz acid vs 2 oz chlorine) -> MUST FAIL
const chemicalsSwappedSameNumber = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-swap-sop-001',
    source_title: 'Chemical SOP',
    step_instructions: 'Add 2 oz of muriatic acid to balance the pool water.'
  },
  [{
    id: 'kb-swap-sop-001',
    company_manual_source: true,
    title: 'Chemical SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Low free chlorine in pool water',
    procedure_text: 'Add 1 oz of muriatic acid and 2 oz of liquid chlorine to properly balance the pool water and raise sanitizer. Test before redosing.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Low free chlorine in pool water'
);
assert.equal(chemicalsSwappedSameNumber.verified, false, 'Case P: Chemical amounts swapped between different compounds must fail verification');

// Case Q: Two chemicals same amount swapped (1 oz chlorine to lower pH vs 1 oz acid) -> MUST FAIL
const chemicalsSwappedSameAmount = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-swap-sop-002',
    source_title: 'pH Adjustment SOP',
    step_instructions: 'Add 1 oz of liquid chlorine to lower pH.'
  },
  [{
    id: 'kb-swap-sop-002',
    company_manual_source: true,
    title: 'pH Adjustment SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'High pH in pool water',
    procedure_text: 'Add 1 oz of muriatic acid to lower pH when alkalinity is within normal operating range. Broadcast evenly across the deep end.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'High pH in pool water'
);
assert.equal(chemicalsSwappedSameAmount.verified, false, 'Case Q: Chemical swapped for incompatible role must fail verification');

// Case R: Properly corroborated chemical addition (1 oz chlorine per 1,000 gal) -> MUST PASS
const properlyCorroboratedChemical = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chlor-sop-003',
    source_title: 'Liquid Chlorine Dosing SOP',
    step_instructions: 'Add 1 oz of liquid chlorine per 1,000 gallons of pool water to raise free chlorine 1 ppm.'
  },
  [{
    id: 'kb-chlor-sop-003',
    company_manual_source: true,
    title: 'Liquid Chlorine Dosing SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Low free chlorine in pool water',
    procedure_text: 'For green algae, add 1 oz of liquid chlorine per 1,000 gallons of pool water to raise free chlorine 1 ppm. Circulate continuously.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Low free chlorine in pool water'
);
assert.equal(properlyCorroboratedChemical.verified, true, 'Case R: Correctly corroborated chemical dose must pass verification');

// Case S: Properly supported no-dose observation -> MUST PASS
const supportedNoDoseObservation = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-obs-sop-001',
    source_title: 'Pre-Filter Inspection SOP',
    step_instructions: 'Inspect pump basket and check water chemistry with test strips before adding any chemicals.'
  },
  [{
    id: 'kb-obs-sop-001',
    company_manual_source: true,
    title: 'Pre-Filter Inspection SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Low water flow and hazy water',
    procedure_text: 'Check pump strainer basket and inspect filter pressure gauge before backwashing. Record initial water chemistry with test strips before adding any chemicals.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Low water flow and hazy water'
);
assert.equal(supportedNoDoseObservation.verified, true, 'Case S: Supported no-dose observation step must pass verification');

// Case T: Nonparsed / ungrounded metric units (ml, %) -> MUST FAIL
const ungroundedMetricDose = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-algae-sop-004',
    source_title: 'Algaecide Treatment SOP',
    step_instructions: 'Dose 1000 ml of algaecide into the pool.'
  },
  [{
    id: 'kb-algae-sop-004',
    company_manual_source: true,
    title: 'Algaecide Treatment SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Algae bloom in pool water',
    procedure_text: 'Dose 500 ml of algaecide and maintain 6% concentration for mustard algae remediation. Ensure circulation runs for 24 hours.'.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Algae bloom in pool water'
);
assert.equal(ungroundedMetricDose.verified, false, 'Case T: Ungrounded metric chemical dose (1000 ml vs 500 ml) must fail verification');

// Case U: Revoked or disabled company manual -> MUST FAIL
const validCompanyManualFixture = {
  id: 'kb-pt-man-001',
  company_manual_source: true,
  title: 'Pentair IntelliFlo VSF Manual',
  brand: 'Pentair',
  model_family: 'IntelliFlo VSF',
  category: 'pump',
  symptom: 'Pump won\'t start, display is dead',
  procedure_text: 'Inspect drive electronics and AC line voltage input to verify power supply. Check that line voltage is 230V AC across L1 and L2.'.repeat(2),
  active: true,
  reference_enabled: true,
  status: 'ready'
};

const revokedManualResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-revoked-001',
    source_title: 'Revoked Pentair SOP',
    step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.'
  },
  [{
    ...validCompanyManualFixture,
    id: 'kb-revoked-001',
    status: 'revoked'
  }],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(revokedManualResult.verified, false, 'Case U-1: Revoked manual must fail citation verification');

const disabledManualResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-disabled-001',
    source_title: 'Disabled Pentair SOP',
    step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.'
  },
  [{
    ...validCompanyManualFixture,
    id: 'kb-disabled-001',
    reference_enabled: false
  }],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(disabledManualResult.verified, false, 'Case U-2: Reference-disabled manual must fail citation verification');

const quarantinedManualResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-quarantined-001',
    source_title: 'Quarantined Pentair SOP',
    step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.'
  },
  [{
    ...validCompanyManualFixture,
    id: 'kb-quarantined-001',
    status: 'quarantined'
  }],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(quarantinedManualResult.verified, false, 'Case U-3: Quarantined manual must fail citation verification');

const sharedRevokedResult = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-shared-revoked-001',
    source_title: 'Shared Revoked Pentair Lesson',
    step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.'
  },
  [{
    ...validPentairLesson,
    id: 'kb-shared-revoked-001',
    publication_status: 'revoked'
  }],
  'Pentair',
  'IntelliFlo VSF',
  'Pump won\'t start, display is dead'
);
assert.equal(sharedRevokedResult.verified, false, 'Case U-4: Shared lesson with publication_status=revoked must fail citation verification');

// --- PART-6 FAIL-CLOSED CONTEXTUAL CHEMICAL GROUNDING TESTS ---
// Case V-1: Source observation (unknown role) "Record shows 2 oz liquid chlorine" cannot verify model "Add 2 oz liquid chlorine" -> MUST FAIL
const observationCannotCorroborateDose = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chem-obs-001',
    source_title: 'Chemical Observation Record',
    step_instructions: 'Add 2 oz of liquid chlorine directly into the pool.'
  },
  [{
    id: 'kb-chem-obs-001',
    company_manual_source: true,
    title: 'Chemical Observation Record',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Routine water inspection record',
    procedure_text: 'Routine field observation log: Record shows 2 oz liquid chlorine was noted in historical inventory. Do not add chemicals without current water test results. '.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Routine water inspection record'
);
assert.equal(observationCannotCorroborateDose.verified, false, 'Case V-1: Source observation with unknown role cannot verify addition dose');

// Case V-2: Negated source concentration matching model target concentration -> MUST FAIL
const negatedSourceConcentration = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chem-conc-001',
    source_title: 'Water Balance Guidelines',
    step_instructions: 'Maintain free chlorine target level at 3 ppm in pool water.'
  },
  [{
    id: 'kb-chem-conc-001',
    company_manual_source: true,
    title: 'Water Balance Guidelines',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Algae bloom in pool water',
    procedure_text: 'For active black algae blooms, do not maintain 3 ppm chlorine as standard maintenance is insufficient. Shocking requires higher concentration. '.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Algae bloom in pool water'
);
assert.equal(negatedSourceConcentration.verified, false, 'Case V-2: Negated source concentration cannot corroborate target concentration');

// Case V-3: Unknown compound (missing compound match) -> MUST FAIL
const unknownCompoundAddition = verifyCitation(
  {
    response_type: 'step',
    source_label: 'internal_manual',
    source_id: 'kb-chem-unk-001',
    source_title: 'Generic Powder Treatment SOP',
    step_instructions: 'Add 2 lbs of mystery clarifying compound to skimmer.'
  },
  [{
    id: 'kb-chem-unk-001',
    company_manual_source: true,
    title: 'Generic Powder Treatment SOP',
    brand: 'Generic',
    model_family: 'Water Care',
    category: 'water_quality',
    symptom: 'Cloudy pool water',
    procedure_text: 'For water clarity treatment, add 2 lbs of mystery clarifying compound slowly into the skimmer with pump running. '.repeat(2)
  }],
  'Generic',
  'Water Care',
  'Cloudy pool water'
);
assert.equal(unknownCompoundAddition.verified, false, 'Case V-3: Unknown compound without recognized safe chemical family must fail verification');

// 12. Helper + synthetic routing simulation (diagnostic routing flow)
// Exercises production routing helpers in a synthetic diagnostic routing sequence showing:
// 1) Positive internal-only answer runs with Gemini Search tools: [] (Search tool is OFF)
// 2) Forced fallback search is NOT invoked
// 3) No ReferenceError occurs
// 4) Negative test: invented step fails corroboration and triggers fallback search
{
  function simulateDiagnosticExecution(candidateRows, brand, model, symptom, mockModelOutput) {
    let googleSearchToolEnabledInFirstPass = null;
    let fallbackSearchInvoked = false;

    // A. Eligibility check (preferVerifiedInternalOnly)
    const firstPassInternalOnly = eligible(candidateRows, brand, model, symptom, 'pump');

    // B. First-pass Gemini call setup
    const firstPassTools = firstPassInternalOnly ? [] : [{ type: 'google_search' }];
    googleSearchToolEnabledInFirstPass = firstPassTools.some(t => t.type === 'google_search');

    // C. Model responds conforming to DIAGNOSTIC_RESPONSE_FORMAT
    const structuredResponse = mockModelOutput;
    const generatedResponseType = String(structuredResponse.response_type || '').toLowerCase();
    const structuredSourceLabel = String(structuredResponse.source_label || '');

    // D. Server-side citation verification
    const internalCitation = verifyCitation(structuredResponse, candidateRows, brand, model, symptom);
    const internalProcedureIsUsable = internalCitation.verified;

    let sourceMode = 'generic';
    let sourceKind = 'none';
    if (internalCitation.verified) {
      sourceMode = 'manual';
      sourceKind = internalCitation.sourceKind;
    }

    const needsSourceGroundedAnswer = true;
    const initialHasEvidence = internalProcedureIsUsable || (structuredSourceLabel === 'manufacturer_web');
    const initialActionComplete = generatedResponseType === 'step' || generatedResponseType === 'escalate';

    // E. Universal fallback search rule
    const shouldRunFallbackSearch = needsSourceGroundedAnswer &&
      (!initialHasEvidence || !initialActionComplete);

    if (shouldRunFallbackSearch) {
      fallbackSearchInvoked = true;
    }

    return {
      firstPassInternalOnly,
      googleSearchToolEnabledInFirstPass,
      citationVerified: internalCitation.verified,
      sourceMode,
      sourceKind,
      fallbackSearchInvoked
    };
  }

  // 12a. Positive test: verified internal KB available + model returns conforming corroborated step
  const positiveRun = simulateDiagnosticExecution(
    [validPentairLesson],
    'Pentair',
    'IntelliFlo VSF',
    'Pump won\'t start, display is dead',
    {
      response_type: 'step',
      source_label: 'internal_manual',
      source_id: 'kb-pt-vsf-001',
      source_title: 'Pentair IntelliFlo VSF Troubleshooting',
      step_instructions: 'Inspect drive electronics and AC line voltage input to verify power supply.',
      safety_warning: 'Turn off circuit breaker before inspecting wiring.',
      follow_up_question: 'Is 240VAC present at terminals?'
    }
  );

  assert.equal(positiveRun.firstPassInternalOnly, true, 'KB match must enable firstPassInternalOnly');
  assert.equal(positiveRun.googleSearchToolEnabledInFirstPass, false, 'Google Search tool MUST BE OFF in first pass');
  assert.equal(positiveRun.citationVerified, true, 'Citation must be verified server-side');
  assert.equal(positiveRun.sourceMode, 'manual');
  assert.equal(positiveRun.sourceKind, 'approved_lesson');
  assert.equal(positiveRun.fallbackSearchInvoked, false, 'Fallback search MUST NOT be invoked when internal citation is verified');

  // 12b. Negative test: model returns invented step not corroborated by KB
  const negativeRun = simulateDiagnosticExecution(
    [validPentairLesson],
    'Pentair',
    'IntelliFlo VSF',
    'Pump won\'t start, display is dead',
    {
      response_type: 'step',
      source_label: 'internal_manual',
      source_id: 'kb-pt-vsf-001',
      step_instructions: 'Replace the entire filter tank shell and drain plug.'
    }
  );

  assert.equal(negativeRun.citationVerified, false, 'Invented step must fail citation verification');
  assert.equal(negativeRun.fallbackSearchInvoked, true, 'Fallback search MUST BE INVOKED when model step is uncorroborated');

  // 12c. Wrong page rejection: Cited page outside chunk page boundary
  const manualChunkWithPages = {
    id: 'kb-pt-chunk-p5',
    company_manual_source: true,
    brand: 'Pentair',
    model_family: 'SuperFlo VST',
    category: 'pump',
    page_start: 5,
    page_end: 7,
    revision: 'Rev P',
    symptom: 'Pump motor will not start, display is dead',
    procedure_text: 'Inspect drive electronics and AC input voltage. Check breaker sizing. If display is dark and breaker trips immediately, inspect drive module for short circuit and verify power wiring. '.repeat(2)
  };

  const wrongPageRun = verifyCitation(
    {
      response_type: 'step',
      source_label: 'internal_manual',
      source_id: 'kb-pt-chunk-p5',
      page_number: 42, // Wrong page!
      step_instructions: 'Inspect drive electronics and AC input voltage.'
    },
    [manualChunkWithPages],
    'Pentair',
    'SuperFlo VST',
    'Pump motor will not start, display is dead'
  );
  assert.equal(wrongPageRun.verified, false, 'Wrong page citation (p. 42 vs pp. 5-7) must fail verification');

  // 12d. Wrong revision rejection: Cited revision does not match manual revision
  const wrongRevRun = verifyCitation(
    {
      response_type: 'step',
      source_label: 'internal_manual',
      source_id: 'kb-pt-chunk-p5',
      page_number: 5,
      revision: 'Rev B', // Wrong revision (actual is Rev P)!
      step_instructions: 'Inspect drive electronics and AC input voltage.'
    },
    [manualChunkWithPages],
    'Pentair',
    'SuperFlo VST',
    'Pump motor will not start, display is dead'
  );
  assert.equal(wrongRevRun.verified, false, 'Wrong revision citation (Rev B vs Rev P) must fail verification');

  // 12e. Fabricated citation ID rejection
  const fabricatedIdRun = verifyCitation(
    {
      response_type: 'step',
      source_label: 'internal_manual',
      source_id: 'kb-nonexistent-uuid-999',
      step_instructions: 'Inspect drive electronics and AC input voltage.'
    },
    [manualChunkWithPages],
    'Pentair',
    'SuperFlo VST',
    'Pump motor will not start, display is dead'
  );
  assert.equal(fabricatedIdRun.verified, false, 'Fabricated citation ID must fail verification');

  // 12f. Invasive uncorroborated action rejection (replacing shaft seal on an electrical chunk)
  const invasiveStepRun = verifyCitation(
    {
      response_type: 'step',
      source_label: 'internal_manual',
      source_id: 'kb-pt-chunk-p5',
      page_number: 5,
      step_instructions: 'Turn off the main breaker and replace the motor shaft seal and wet end o-ring.'
    },
    [manualChunkWithPages],
    'Pentair',
    'SuperFlo VST',
    'Pump motor will not start, display is dead'
  );
  assert.equal(invasiveStepRun.verified, false, 'Invented replacement action absent from procedure must fail verification');
}

// 13. Static wiring assertions on handler source
assert.match(source, /verifyInternalCitation\(structuredResponse,\s*kbRows,\s*brand,\s*model/);
assert.doesNotMatch(source, /verifyInternalCitation\(structured,\s*kbRows/);
assert.match(source, /relevantWaterQualityProcedurePresent && internalCitation\.verified/);
assert.doesNotMatch(source, /relevantWaterQualityProcedurePresent && \(internalCitation\.verified \|\| structuredSourceLabel === "internal_manual"\)/);
assert.match(source, /sourceMode = "manual"/);
assert.match(source, /let sourceKind:\s*"company_sop" \| "approved_lesson" \| "manufacturer_web" \| "none"/);
assert.match(source, /if \(row\.technician_verified && effectiveCaseOptIn && companyOptedIn\) \{/,
  'technician jobs must have explicit verified contributor terms and company consent to enter review queue');
assert.match(source, /case_learning_opt_in:\s*effectiveCaseOptIn/,
  'save_technician_job properly persists verified effectiveCaseOptIn on diagnostic_cases');
assert.match(source, /code: "VERIFIED_REPAIR_REQUIRED"/,
  'unresolved technician lessons cannot pass shared-knowledge approval');
assert.match(source, /caseRow\?\.case_learning_opt_in === true/,
  'case-level dual consent mandatory for shared learning');

// 14. Commercial policy & price stability invariants
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

console.log('PASS: all Part-4 knowledge-first routing, mandatory cited source ID, dosage corroboration, synthetic routing simulation, and price invariants succeeded.');

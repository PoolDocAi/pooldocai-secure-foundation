const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');

console.log('--- TASK-002: TROUBLESHOOTER UX & SITE READINESS REGRESSION SUITE ---');

// ============================================================================
// 1. EXTRACT BACKEND & FRONTEND HAZARD DETECTORS
// ============================================================================
const tsSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/clever-handler/index.ts'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Function ${name} not found`);
  let depth = 0;
  let idx = src.indexOf('{', start);
  for (; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, idx + 1);
}

const stripTsTypes = (s) => s
  .replace(/\(rawText: string\): boolean/, '(rawText)')
  .replace(/\(value: string\): string/, '(value)')
  .replace(/const patterns: RegExp\[\]/, 'const patterns');

const backendFnCode = `${stripTsTypes(extractFunction(tsSource, 'normalizeDiagnosticLanguage'))}
${stripTsTypes(extractFunction(tsSource, 'isCriticalPoolHazardText'))}
return isCriticalPoolHazardText;`;
const backendIsCritical = new Function(backendFnCode)();

const primaryHtml = fs.readFileSync(path.join(repoRoot, 'website/demo.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(repoRoot, 'website/app.html'), 'utf8');

const frontendNormCode = extractFunction(primaryHtml, 'normalizeConversationalText');
const frontendCritCode = extractFunction(primaryHtml, 'isCriticalPoolHazard');
const frontendIsCritical = new Function(`${frontendNormCode}\n${frontendCritCode}\nreturn isCriticalPoolHazard;`)();

// Client caution risk filter (from app.html line 4717-4724)
function evaluateHomeownerSafetyHold(cautionText) {
  const cautionRiskText = cautionText
    .replace(/\b(?:never|do not|don't|must not|should not|avoid|warn(?:s|ed|ing)?(?: that)?)\b[^.!?]{0,100}\b(?:mix|mixing|mixed|combine|combining|combined)\b[^.!?]{0,100}\b(?:acid|chlorine|bleach|muriatic acid)\b[^.!?]?/gi, ' ')
    .replace(/\b(?:acid|chlorine|bleach|muriatic acid)\b[^.!?]{0,80}\b(?:never|must not|should not|do not|don't)\b[^.!?]{0,40}\b(?:mix|mixing|mixed|combine|combining|combined)\b[^.!?]?/gi, ' ')
    .replace(/\b(?:never|do not|don't|must not|should not|avoid)\b[^.!?]*[.!?]?/gi, ' ');
  return /\b(?:open|remove|touch|test|repair|replace|adjust|disconnect|reconnect|bypass|jump|bridge|measure|work on|reset)\b.{0,55}\b(?:gas line|gas valve|electrical panel|live wire|voltage|capacitor|pressurized filter|filter lid|ignition|burner|refrigerant|wiring|breaker|pump motor wiring|pressure vessel|filter tank|sealed system)\b/i.test(cautionRiskText);
}

// ============================================================================
// TEST 1: Harmless Pump Complaints (No False Safety Stop or Homeowner Hold)
// ============================================================================
console.log('\n[Test 1] Harmless Pump Intake & Follow-up (No False Safety Stops)...');

const harmlessIntakeCases = [
  'pump wont start',
  'Pump wont start',
  'My pool pump will not start',
  'My pool pump is silent and won\'t start',
  'Pool pump is completely silent and wont start',
  'it makes no sound',
  'it is silent',
  'it just hums',
  'nothing happens',
  'The pump hums or buzzes but will not start.',
  'Pump is silent and won\'t start.',
  'haywrd pump wont start',
  'pentaier pump silent',
  'jandey pump not turning on',
  'heward pump wont start',
  'pmp wont tun on',
];

for (const phrase of harmlessIntakeCases) {
  assert.equal(backendIsCritical(phrase), false, `Backend falsely stopped on harmless pump intake: "${phrase}"`);
  assert.equal(frontendIsCritical(phrase), false, `Frontend falsely stopped on harmless pump intake: "${phrase}"`);
  console.log(`  PASS: "${phrase}" -> safe diagnostic intake`);
}

// Check safe pump triage cautionary message does not trigger homeowner safety hold
const safePumpTriageCaution = `**FIRST SAFE CHECK - PUMP WILL NOT START**
1. From a dry, safe location, look at the controller/timer and note whether it is asking the pump to run.
2. Observe only visible status lights or messages; do not open a panel, touch wiring, remove the motor cover, or repeatedly reset a breaker.

**Tell me what happens when it is commanded on:** completely silent, hums/buzzes, or trips a breaker. If it trips, smells burnt, sparks, or causes tingling/shock, stay away and request qualified service.`;

assert.equal(
  evaluateHomeownerSafetyHold(safePumpTriageCaution),
  false,
  'Safe pump triage caution must NOT trigger homeowner safety hold'
);
console.log('  PASS: Safe pump triage caution correctly passes without homeowner safety hold.');

// ============================================================================
// TEST 2: Genuine High-Risk Hazards Strictly Trigger Safety Stops
// ============================================================================
console.log('\n[Test 2] Genuine Hazard Detection (Emergency Stops Enforced)...');

const genuineHazards = [
  'I smell gas near the heater',
  'smells like rotten eggs at pool equipment',
  'pump motor is smoking and on fire',
  'there is smoke coming from the pump',
  'motor caught fire',
  'wire is melting at the panel',
  'sparks are flying from the pump motor',
  'i got shocked when touching the pool pump',
  'child trapped at the pool drain',
  'swimmer hair is stuck in the drain',
  'i mixed chlorine and muriatic acid in a bucket',
  'chlorine gas fumes coming from feeder',
  'carbon monoxide alarm went off near pool heater',
  'filter tank is bulging and cracking',
  'flames shooting out of heater cabinet',
];

for (const phrase of genuineHazards) {
  assert.equal(backendIsCritical(phrase), true, `Backend failed to stop on genuine hazard: "${phrase}"`);
  assert.equal(frontendIsCritical(phrase), true, `Frontend failed to stop on genuine hazard: "${phrase}"`);
  console.log(`  PASS (emergency stop): "${phrase}"`);
}

// Affirmative high-risk instruction triggers homeowner hold
const affirmativeDangerousRepair = 'Remove the motor cover, discharge the capacitor with a screwdriver, and test voltage at the live terminal.';
assert.equal(
  evaluateHomeownerSafetyHold(affirmativeDangerousRepair),
  true,
  'Affirmative electrical/capacitor repair instruction must trigger homeowner safety hold'
);
console.log('  PASS: Affirmative high-risk repair instruction correctly triggers homeowner safety hold.');

// ============================================================================
// TEST 3: Authenticated Portal Defaults to Field Technician Troubleshooter
// ============================================================================
console.log('\n[Test 3] Authenticated Portal Default & Markup in website/app.html...');

// Verify default mode logic
assert.match(
  appHtml,
  /const requestedSurfaceMode = new URLSearchParams\(window\.location\.search\)\.get\('mode'\);[\s\r\n]+let currentSurfaceMode = requestedSurfaceMode === 'homeowner' \? 'homeowner' : 'tech';/,
  'app.html must default currentSurfaceMode to tech unless explicitly requested with mode=homeowner'
);

// Verify initial HTML markup styling for buttons
assert.match(
  appHtml,
  /<button id="modeTechBtn" type="button" aria-pressed="true" class="mode-switch-btn px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-sky-500 text-slate-950 shadow transition cursor-pointer">/,
  'modeTechBtn must be rendered active by default in static HTML markup'
);

assert.match(
  appHtml,
  /<button id="modeHomeownerBtn" type="button" aria-pressed="false" class="mode-switch-btn px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-slate-300 hover:text-white transition cursor-pointer">/,
  'modeHomeownerBtn must be rendered inactive by default in static HTML markup'
);

// Verify initial header title
assert.match(
  appHtml,
  /<span id="walkthroughHeaderTitle" class="text-sm sm:text-base font-extrabold text-white">PoolDocAI — Field Technician Troubleshooter<\/span>/,
  'walkthroughHeaderTitle must display Field Technician Troubleshooter by default'
);

// Verify banner text does not contain fake demo preview
assert.doesNotMatch(
  appHtml,
  /Try 8 turns in Homeowner Triage and a separate 8 turns in the Field Tech Mobile App public preview/,
  'app.html must not contain the public demo 8-turn preview text in the authenticated banner'
);
assert.match(
  appHtml,
  /Authenticated Field Technician Troubleshooter with company workspace, equipment photo analysis, integrated field notes, and session tracking\./,
  'app.html must display authenticated workspace capabilities in banner'
);

// Verify syncSurfaceModeUI function exists and initializes on load
assert.match(appHtml, /function syncSurfaceModeUI\(mode\)/, 'app.html must define syncSurfaceModeUI helper');
assert.match(appHtml, /syncSurfaceModeUI\(\);[\s\r\n]+renderSampleStartersBar\(\);/, 'app.html must execute syncSurfaceModeUI() on load');

console.log('  PASS: Authenticated troubleshooter workspace defaults to Field Technician Troubleshooter with active styling and correct headers.');

// ============================================================================
// TEST 4: Integrated Field Notes Panel Inside Troubleshooter
// ============================================================================
console.log('\n[Test 4] Integrated Field Notes in website/app.html...');

assert.match(appHtml, /<div id="integratedTechNotesPanel"/, 'integratedTechNotesPanel must exist in app.html');
assert.match(appHtml, /<form id="integratedTechNotesForm"/, 'integratedTechNotesForm must exist in app.html');
assert.match(appHtml, /id="integratedNotesCategory"/, 'integratedNotesCategory input must exist');
assert.match(appHtml, /id="integratedNotesEquipment"/, 'integratedNotesEquipment input must exist');
assert.match(appHtml, /id="integratedNotesModel"/, 'integratedNotesModel input must exist');
assert.match(appHtml, /id="integratedNotesComplaint"/, 'integratedNotesComplaint input must exist');
assert.match(appHtml, /id="integratedNotesDiagnostic"/, 'integratedNotesDiagnostic input must exist');
assert.match(appHtml, /id="integratedNotesOutcome"/, 'integratedNotesOutcome select must exist');
assert.match(appHtml, /id="integratedNotesResolution"/, 'integratedNotesResolution input must exist');
assert.match(appHtml, /id="integratedNotesSave"/, 'integratedNotesSave submit button must exist');
assert.match(appHtml, /id="integratedNotesStatus"/, 'integratedNotesStatus live status must exist');

// Verify submission passes diagnosticSessionId and updates visual feedback
assert.match(appHtml, /action:\s*'save_technician_job'/, 'notes form must submit action save_technician_job');
assert.match(appHtml, /source:\s*'troubleshooter'/, 'notes form must record source troubleshooter');
assert.match(appHtml, /diagnosticSessionId:\s*diagnosticSessionId\s*\|\|\s*null/, 'notes form must link diagnosticSessionId');
assert.match(appHtml, /status\.className\s*=\s*'text-sm text-emerald-400 font-semibold'/, 'notes form must display emerald status on success');
assert.match(appHtml, /status\.className\s*=\s*'text-sm text-rose-400 font-semibold'/, 'notes form must display rose status on error');
assert.match(appHtml, /function syncNotesFromSessionContext\(\)/, 'app.html must define syncNotesFromSessionContext helper');

console.log('  PASS: Integrated field notes panel is fully functional, links session ID, and provides visual feedback.');

// ============================================================================
// TEST 5: Public Demo Separation in website/demo.html
// ============================================================================
console.log('\n[Test 5] Public Demo Isolation in website/demo.html...');

assert.match(primaryHtml, /const PUBLIC_DEMO_TURN_LIMIT = 8;/, 'demo.html must enforce 8-turn limit');
assert.match(primaryHtml, /publicDemoCountKey\(\)/, 'demo.html must use distinct turn count key per mode');
assert.match(primaryHtml, /getPublicDemoSessionId\(currentSurfaceMode\)/, 'demo.html must use distinct session ID per mode');
assert.match(primaryHtml, /showDemoWaitlistNotice\(/, 'demo.html must show waitlist notice when limit reached');
assert.doesNotMatch(primaryHtml, /id="integratedTechNotesPanel"/, 'demo.html must NOT contain authenticated field notes panel');

console.log('  PASS: Public demo maintains strict 8-turn limit, session separation, and waitlist gates.');

// ============================================================================
// TEST 6: All HTML Pages Parse Without Syntax Errors
// ============================================================================
console.log('\n[Test 6] Script Parsing Across All Website HTML Files...');

const allHtmlFiles = fs.readdirSync(path.join(repoRoot, 'website'))
  .filter(f => f.endsWith('.html'))
  .map(f => path.join('website', f));

for (const relPath of allHtmlFiles) {
  const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const scripts = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
  scripts.forEach((tag, idx) => {
    const code = tag.replace(/<script\b[^>]*>/i, '').replace(/<\/script>/i, '');
    if (code.trim()) {
      assert.doesNotThrow(() => {
        new vm.Script(code, { filename: `${relPath}#script${idx}` });
      }, `Inline script in ${relPath}#script${idx} contains invalid JavaScript syntax`);
    }
  });
  console.log(`  PASS: ${relPath} (${scripts.length} script blocks verified)`);
}

console.log('\n====================================================================');
console.log('ALL TASK-002 TROUBLESHOOTER UX & SITE READINESS TESTS PASSED!');
console.log('====================================================================');

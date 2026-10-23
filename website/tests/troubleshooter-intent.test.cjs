const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bundleRoot = path.resolve(__dirname, '..', '..');
const htmlFiles = [
  'website/demo.html',
  'website/app.html',
  'website/faq.html',
  'website/how-it-works.html',
  'website/waitlist.html',
  'website/index.html',
  'website/pricing.html',
];
const primaryHtml = fs.readFileSync(path.join(bundleRoot, 'website/demo.html'), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const intentFunctions = sliceBetween(
  primaryHtml,
  'function normalizeConversationalText(rawText)',
  'function isNotSureResponse(qLower)'
);
const categoryFunction = sliceBetween(
  primaryHtml,
  'function detectCategoryFromText(qLower)',
  'function detectBrandFromText(qLower)'
);
const specificityFunction = sliceBetween(
  primaryHtml,
  'function isSpecificSymptomDescription(text, subType)',
  'function updateSessionContextFromMessage(rawText)'
);
const helpers = new Function(
  `${intentFunctions}\n${categoryFunction}\n${specificityFunction}\nreturn { normalizeConversationalText, detectSubTypeOrDetailFromText, detectCategoryFromText, isSpecificSymptomDescription };`
)();

// Category + symptom pairs verify conversational interpretation, not exact-button matching.
const tests = [
  ['Cant turn on my pump', 'Pump', "Won't Start (Sound Not Yet Confirmed)"],
  ['My pool pump will not start', 'Pump', "Won't Start (Sound Not Yet Confirmed)"],
  ['Jandy pump wont start', 'Pump', "Won't Start (Sound Not Yet Confirmed)"],
  ['Pump hums but wont start', 'Pump', 'Humming / Thermal Trip'],
  ['Pool pump is completely silent and wont start', 'Pump', 'Silent / No Power'],
  ['My pump is leaking water', 'Pump', 'Water Leak'],
  ['My pump keeps losing prime', 'Pump', 'Losing Prime'],
  ['My filter pressure is too high', 'Filter', 'High Filter Pressure'],
  ['Filter is not filtering and dirt comes back', 'Filter', 'Poor Filtration'],
  ['Water flow from returns is weak and filter pressure low', 'Filter', 'Low Flow / Pressure'],
  ['My schedule wont run at the right time', 'Automation', 'Schedule / Timer Not Running'],
  ['The automation controller is offline', 'Automation', 'Controller / Communication Issue'],
  ['My Polaris cleaner wont move', 'Cleaner', "Cleaner Won't Start / Move"],
  ['Robot cleaner leaves debris', 'Cleaner', 'Poor Cleaning'],
  ['The pool light keeps flickering', 'Lighting', 'Flicker / Color Issue'],
  ['Pool light wont turn on', 'Lighting', "Light Won't Turn On"],
  ['My salt system says low salt', 'Sanitizer / Chlorine', 'Salt System Indicator / Code'],
  ['My chlorine is low', 'Sanitizer / Chlorine', 'Low / No Chlorine Output'],
  ['My valve is stuck and wont switch', 'Valves', 'Valve / Actuator Position Issue'],
  ['Pool water looks cloudy', 'Water Quality / General', 'Cloudy Water'],
  ['My pool is green', 'Water Quality / General', 'Green Water / Possible Algae'],
  ['Need help with my pool water', 'Water Quality / General', 'Water Chemistry / Test Results'],
  ['Water chemistry is off', 'Water Quality / General', 'Water Chemistry / Test Results'],
  ['My heater wont heat the water', 'Heater', 'Heating / No Heat'],
  // Common spelling errors across equipment families must route on the first turn.
  ['My pmp wont tun on', 'Pump', "Won't Start (Sound Not Yet Confirmed)"],
  ['Filter presure is hihg', 'Filter', 'High Filter Pressure'],
  ['The automaton schdule keeps skiping', 'Automation', 'Schedule / Timer Not Running'],
  ['My cleanr isnt movng', 'Cleaner', "Cleaner Won't Start / Move"],
  ['The clorine is low', 'Sanitizer / Chlorine', 'Low / No Chlorine Output'],
  ['My heeter isnt heeting', 'Heater', 'Heating / No Heat'],
  ['My vlave wont swtich', 'Valves', 'Valve / Actuator Position Issue'],
  ['The pool lgiht wont turnon', 'Lighting', "Light Won't Turn On"],
  ['Pool water is clowdy', 'Water Quality / General', 'Cloudy Water'],
];

for (const [message, expectedCategory, expectedSubtype] of tests) {
  const normalized = helpers.normalizeConversationalText(message);
  const category = helpers.detectCategoryFromText(normalized);
  assert.equal(category, expectedCategory, `Category not recognized for: ${message}`);
  const actual = helpers.detectSubTypeOrDetailFromText(normalized, expectedCategory);
  assert.equal(actual, expectedSubtype, `Unexpected routing for: ${message}`);
  assert.equal(
    helpers.isSpecificSymptomDescription(message, actual),
    true,
    `A clear reported symptom should count as specific: ${message}`
  );
  console.log(`PASS: ${message} -> ${category} / ${actual}`);
}

assert.equal(
  helpers.normalizeConversationalText('Cant turn on / Wont start / doesnt run / chemstry / fliter / presure / clorine / clowdy / lgiht / gass / sparrking / shok'),
  "can't turn on / won't start / doesn't run / chemistry / filter / pressure / chlorine / cloudy / light / gas / sparking / shock"
);
assert.equal(helpers.detectSubTypeOrDetailFromText(helpers.normalizeConversationalText('Wont turn on'), 'Pump'), "Won't Start (Sound Not Yet Confirmed)", 'a short follow-up should use the already-known pump category');
assert.equal(helpers.detectCategoryFromText(helpers.normalizeConversationalText('my pump wont tun on')), 'Pump');
assert.equal(helpers.isSpecificSymptomDescription('my pump wont tun on', null), true);
assert.equal(helpers.detectSubTypeOrDetailFromText(helpers.normalizeConversationalText('it just hums'), 'Pump'), 'Humming / Thermal Trip', 'a continued reply should normalize and recognize a new operating observation');
assert.equal(helpers.detectSubTypeOrDetailFromText(helpers.normalizeConversationalText('pressure is still hihg'), 'Filter'), 'High Filter Pressure', 'follow-up observations should use the same normalization as intake');
assert.equal(helpers.isSpecificSymptomDescription('heater isnt heeting', null), true, 'specific typo-bearing initial descriptions remain actionable');

// A prohibition may list several actions ("avoid resetting, opening, or replacing ...").
// Strip the entire caution sentence before scanning for affirmative hazardous instructions.
const prohibitionSentenceFilter = /\b(?:never|do not|don't|must not|should not|avoid)\b[^.!?]*[.!?]?/gi;
const cautionOnly = 'Avoid repeatedly resetting a tripping breaker, opening the motor cover, or touching wiring. Check the visible status from a dry location.';
assert.equal(cautionOnly.replace(prohibitionSentenceFilter, ' ').trim(), 'Check the visible status from a dry location.', 'a prohibition list must not trigger a false homeowner repair hold');
const affirmativeHazard = 'Replace the capacitor and test live voltage at the motor.';
assert.match(affirmativeHazard, /\b(?:replace|test)\b.{0,55}\b(?:capacitor|voltage)\b/i, 'affirmative hazardous instructions remain detectable');

for (const relativePath of htmlFiles) {
  const html = fs.readFileSync(path.join(bundleRoot, relativePath), 'utf8');
  assert.doesNotMatch(html, /\\\$\{(?:replyText|getLocalTroubleshootingFallback\(userText\)|fallback)\}/, relativePath + ' contains an escaped interpolation placeholder');
  assert.match(html, /function normalizeConversationalText\(rawText\)/, `${relativePath} missing conversational normalization`);
  if (relativePath === 'website/demo.html' || relativePath === 'website/app.html') assert.ok(html.includes(String.raw`.replace(/\b(?:never|do not|don't|must not|should not|avoid)\b[^.!?]*[.!?]?/gi, ' ');`), `${relativePath} must strip a complete prohibition sentence before hazard detection`);
  if (relativePath === 'website/app.html') assert.match(html, /const requestedSurfaceMode = new URLSearchParams\(window\.location\.search\)\.get\('mode'\)/, 'the account portal field-tech link must open the authenticated troubleshooter in tech mode');
  assert.match(html, /sessionContext\.lastUserObservation = q\.slice\(0, 600\)/, `${relativePath} does not preserve each latest typed observation`);
  assert.match(html, /normalizedLatestUserMessage: String\(sessionContext\.normalizedLatestUserMessage \|\| normalizeConversationalText\(userText\)\)/, `${relativePath} does not pass normalized language for continued turns`);
  assert.match(html, /const lower = normalizeConversationalText\(q\)/, `${relativePath} should normalize initial and continued messages before routing`);
  assert.match(html, /if \(sessionContext\.category === 'Pump' && !sessionContext\.subType && !sessionContext\.initialTriageComplete && !sessionContext\.makeConfirmed\)/, `${relativePath} may repeat the pump symptom menu after a specific report`);
  assert.match(html, /if \(sessionContext\.category && !sessionContext\.makeConfirmed && !sessionContext\.initialTriageComplete && MAKE_TRIAGE_PROMPTS\[sessionContext\.category\]\)/, `${relativePath} may block specific free-text symptoms on the brand selector`);
  assert.match(html, /if \(sessionContext\.category && sessionContext\.initialTriageComplete && !isModelResolved\(\)\)/, `${relativePath} is missing the general-mode fallback for clear symptoms`);
  assert.match(html, /setTimeout\(\(\) => controller\.abort\(\), 120000\)/, `${relativePath} does not leave time for the grounded-search fallback`);
  assert.match(html, /REQUEST A POOL SERVICE TECHNICIAN/, `${relativePath} lacks a prominent technician-service CTA`);
  assert.match(html, /min-h-\[80px\].*text-xl sm:text-2xl/, `${relativePath} technician CTA may be too small for accessible viewing`);
  assert.match(html, /text-3xl sm:text-4xl font-black/, `${relativePath} technician recommendation heading is not large-print`);
  assert.match(html, /serviceHelpAvailable: !techMode/, `${relativePath} should expose the generic service handoff only in homeowner mode after a failed lookup`);
  assert.match(html, /serviceHelpAvailable: currentSurfaceMode !== 'tech'/, `${relativePath} must suppress generic service CTAs in field-tech mode`);
  assert.match(html, /FIELD-TECH DIAGNOSTIC CONTINUATION/, `${relativePath} should continue technician diagnosis instead of ending at a generic escalation`);
  assert.match(html, /retrying once before safe fallback/, `${relativePath} should retry a failed technician-mode lookup once`);
  assert.match(html, /PUMP RUNNING, BUT FLOW IS WEAK/, `${relativePath} should distinguish weak-flow symptoms from a pump that will not start`);
  assert.match(html, /FIRST SAFE CHECK/, `${relativePath} connection-failure fallback lacks a concrete safe first step`);
  assert.match(html, /A POOL SERVICE TECHNICIAN IS THE RECOMMENDED NEXT STEP/, `${relativePath} needs a direct, plain-language technician recommendation`);
  assert.match(html, /technicianRecommended: true/, `${relativePath} should surface a prominent card before the service handoff`);
  const escalationBranch = sliceBetween(html, 'const requiresTechnician =', 'const metadataOnlyResult = isMetadataOnlyKbResponse(payload)');
  assert.match(escalationBranch, /if \(requiresTechnician && currentSurfaceMode !== 'tech'\)/, `${relativePath} should keep homeowner service escalation`);
  assert.match(escalationBranch, /if \(requiresTechnician && currentSurfaceMode === 'tech'\)/, `${relativePath} should continue diagnosis in field-tech mode`);
  assert.match(escalationBranch, /explicitCriticalStop/, `${relativePath} must preserve explicit critical safety stops`);
  assert.match(escalationBranch, /technicianRecommended: true/, `${relativePath} should mark homeowner service escalation as prominent`);
  assert.doesNotMatch(escalationBranch, /buildTechnicianEscalationTurn\(/, `${relativePath} should show the accessible recommendation before opening the handoff form`);
}

const backend = fs.readFileSync(path.join(bundleRoot, 'supabase/functions/clever-handler/index.ts'), 'utf8');
assert.match(backend, /function hasActionableDiagnosticSymptom/, 'backend must infer clear free-text symptoms even when client flags are stale');
assert.match(backend, /function isLikelyDiagnosticContinuation/, 'backend should interpret short continuation observations using existing case context');
assert.match(backend, /const text = normalizeDiagnosticLanguage\(rawText\)\.replace\(\/\\s\+\/g, \" \"\)/, 'server critical-hazard detection must also normalize typos');
assert.match(backend, /const diagnosticSearchQuery = \[latestCustomerMessage, normalizedLatestCustomerMessage/, 'the latest conversational turn should be first in retrieval so long session facts do not truncate it');
assert.match(backend, /NORMALIZED LATEST-MESSAGE ROUTING AID/, 'backend AI instructions should receive a normalized copy for every turn');
assert.match(backend, /on EVERY turn—not only the initial intake/, 'system prompt should explicitly apply language interpretation to follow-up messages');
assert.match(backend, /context\.requireExactModelSelection === true/, 'normal diagnosis should not be blocked by unknown model selection');
assert.match(backend, /technicianRecommended: sourceLookupUncertain \|\| generatedResponseType === "escalate"/, 'source uncertainty and explicit escalation should produce a prominent technician recommendation');
assert.match(backend, /same conversational-understanding and source-based diagnostic methodology across pumps\/motors, filters, valves, heaters, automation\/controllers, schedules\/timers, cleaners, sanitizer\/chlorine systems, lighting, circulation\/flow, water chemistry/, 'backend system prompt should apply the same method across categories');
assert.match(backend, /MANDATORY SEARCH OVERRIDE: You must invoke Google Search grounding/, 'fallback should explicitly require web search');
assert.match(backend, /dirt comes back|returns are weak/, 'backend actionability should recognize filter/flow symptoms');
console.log(`PASS: ${tests.length} typo-tolerant initial-message cases plus follow-up normalization checks across seven frontend surfaces, accessible escalation, and backend routing passed.`);

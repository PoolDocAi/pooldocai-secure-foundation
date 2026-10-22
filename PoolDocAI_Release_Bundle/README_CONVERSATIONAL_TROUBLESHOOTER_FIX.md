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
  helpers.normalizeConversationalText('Cant turn on / Wont start / doesnt run / chemstry / fliter'),
  "can't turn on / won't start / doesn't run / chemistry / filter"
);
assert.equal(helpers.detectSubTypeOrDetailFromText(helpers.normalizeConversationalText('Wont turn on'), 'Pump'), "Won't Start (Sound Not Yet Confirmed)", 'a short follow-up should use the already-known pump category');
assert.equal(helpers.detectCategoryFromText(helpers.normalizeConversationalText('my pump wont tun on')), 'Pump');
assert.equal(helpers.isSpecificSymptomDescription('my pump wont tun on', null), true);

for (const relativePath of htmlFiles) {
  const html = fs.readFileSync(path.join(bundleRoot, relativePath), 'utf8');
  assert.match(html, /function normalizeConversationalText\(rawText\)/, `${relativePath} missing conversational normalization`);
  assert.match(html, /if \(sessionContext\.category === 'Pump' && !sessionContext\.subType && !sessionContext\.initialTriageComplete && !sessionContext\.makeConfirmed\)/, `${relativePath} may repeat the pump symptom menu after a specific report`);
  assert.match(html, /if \(sessionContext\.category && !sessionContext\.makeConfirmed && !sessionContext\.initialTriageComplete && MAKE_TRIAGE_PROMPTS\[sessionContext\.category\]\)/, `${relativePath} may block specific free-text symptoms on the brand selector`);
  assert.match(html, /if \(sessionContext\.category && sessionContext\.initialTriageComplete && !isModelResolved\(\)\)/, `${relativePath} is missing the general-mode fallback for clear symptoms`);
  assert.match(html, /setTimeout\(\(\) => controller\.abort\(\), 120000\)/, `${relativePath} does not leave time for the grounded-search fallback`);
  assert.match(html, /REQUEST A POOL SERVICE TECHNICIAN/, `${relativePath} lacks a prominent technician-service CTA`);
  assert.match(html, /min-h-\[80px\].*text-xl sm:text-2xl/, `${relativePath} technician CTA may be too small for accessible viewing`);
  assert.match(html, /text-3xl sm:text-4xl font-black/, `${relativePath} technician recommendation heading is not large-print`);
  assert.match(html, /serviceHelpAvailable: true/, `${relativePath} connection-failure fallback does not expose technician help`);
  assert.match(html, /FIRST SAFE CHECK/, `${relativePath} connection-failure fallback lacks a concrete safe first step`);
  assert.match(html, /A POOL SERVICE TECHNICIAN IS THE RECOMMENDED NEXT STEP/, `${relativePath} needs a direct, plain-language technician recommendation`);
  assert.match(html, /technicianRecommended: true/, `${relativePath} should surface a prominent card before the service handoff`);
}

const backend = fs.readFileSync(path.join(bundleRoot, 'supabase/functions/clever-handler/index.ts'), 'utf8');
assert.match(backend, /function hasActionableDiagnosticSymptom/, 'backend must infer clear free-text symptoms even when client flags are stale');
assert.match(backend, /context\.requireExactModelSelection === true/, 'normal diagnosis should not be blocked by unknown model selection');
assert.match(backend, /technicianRecommended: sourceLookupUncertain \|\| generatedResponseType === "escalate"/, 'source uncertainty and explicit escalation should produce a prominent technician recommendation');
assert.match(backend, /same conversational-understanding and source-based diagnostic methodology across pumps\/motors, filters, valves, heaters, automation\/controllers, schedules\/timers, cleaners, sanitizer\/chlorine systems, lighting, circulation\/flow, water chemistry/, 'backend system prompt should apply the same method across categories');
assert.match(backend, /MANDATORY SEARCH OVERRIDE: You must invoke Google Search grounding/, 'fallback should explicitly require web search');
assert.match(backend, /dirt comes back|returns are weak/, 'backend actionability should recognize filter/flow symptoms');
console.log(`PASS: ${tests.length} conversational cases across all categories, seven frontend surfaces, accessible escalation, and backend methodology checks passed.`);


## All-turn conversational normalization update

The latest release normalizes informal wording and common pool-equipment typos on every turn, including follow-up observations. Original text is preserved; the normalized form is included as a routing/retrieval hint for the backend. Current-turn wording is prioritized in manual and shared-learning search queries, so long session context cannot push the actual observation out of the query limit. Follow-ups such as “still won't start”, “it just hums”, “no change”, and “that didn't help” are interpreted using the active case context rather than restarting intake. Regression tests cover initial and continuing turns across equipment, controls/schedules, cleaners, lighting, sanitation, valves, filtration, and water-quality questions.


## Follow-up: false-positive homeowner safety holds and calmer technician CTA

- Homeowner safety screening now looks for an affirmative hazardous repair instruction, not merely a mention of words such as “capacitor,” “electrical,” or “pressurized.” Explicit prohibitions such as “do not open the electrical panel” are excluded from the risk scan, while affirmative instructions to open panels, test voltage, remove pressurized lids, replace capacitors, or bypass a safety switch remain blocked in homeowner mode. The original reply shown to the user is not rewritten by the risk-scan cleanup.
- The “Request a pool service technician” CTA remains visible and easy to tap, but uses a smaller sentence-case heading, a restrained blue/gray style, and a 56px minimum button height rather than an all-caps, thick amber emergency-style treatment.
- Regression coverage includes warning-only wording (must not be falsely blocked) as well as affirmative dangerous repair instructions (must remain blocked).

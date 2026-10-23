const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

// 1. Extract backend detector from clever-handler/index.ts
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

// 2. Extract frontend detector from demo.html and app.html
const htmlFiles = [
  'website/demo.html',
  'website/app.html',
  'website/faq.html',
  'website/how-it-works.html',
  'website/waitlist.html',
  'website/index.html',
  'website/pricing.html',
];

const primaryHtml = fs.readFileSync(path.join(repoRoot, 'website/demo.html'), 'utf8');
const frontendNormCode = extractFunction(primaryHtml, 'normalizeConversationalText');
const frontendCritCode = extractFunction(primaryHtml, 'isCriticalPoolHazard');
const frontendIsCritical = new Function(`${frontendNormCode}\n${frontendCritCode}\nreturn isCriticalPoolHazard;`)();

// Non-hazard cases that MUST NOT trigger a safety stop
const nonHazards = [
  'pump wont start',
  'My pool pump will not start',
  'Jandy pump wont start',
  'Pump hums but wont start',
  'Pool pump is completely silent and wont start',
  'The pump hums or buzzes but will not start.',
  'Pump is silent and won\'t start.',
  'My pool pump hums loudly when turned on but won\'t rotate',
  'heater wont fire',
  'heater wont fire up',
  'heater misfires',
  'heater igniter sparks but wont light',
  'No burning smell, no sparks, it is just silent',
  'No, I don\'t smell gas. Pump just hums',
  'there is no smoke, pump just wont start',
  'without any burning smell or sparks',
  'air is trapped in my pool pump',
  'anyone know why air is trapped in my pool pump',
  'I shocked the pool yesterday and now the pump wont start',
  'smoke: none, burning: no',
  'if you smell burning let me know',
  'there are fire ants near the pump',
];

for (const phrase of nonHazards) {
  assert.equal(
    backendIsCritical(phrase),
    false,
    `Backend falsely stopped on non-hazard: "${phrase}"`
  );
  assert.equal(
    frontendIsCritical(phrase),
    false,
    `Frontend falsely stopped on non-hazard: "${phrase}"`
  );
  console.log(`PASS (safe / no stop): "${phrase}"`);
}

// Critical hazard cases that MUST trigger an emergency stop
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
  assert.equal(
    backendIsCritical(phrase),
    true,
    `Backend failed to stop on genuine hazard: "${phrase}"`
  );
  assert.equal(
    frontendIsCritical(phrase),
    true,
    `Frontend failed to stop on genuine hazard: "${phrase}"`
  );
  console.log(`PASS (emergency stop): "${phrase}"`);
}

// Multi-turn test: ensure assistant warning text echoed in state lock does NOT trigger turn 2 stop
const pumpWarningStep = 'Which best describes the pump when commanded on: completely silent, hums/buzzes, or the breaker trips? If a breaker trips, you smell burning, see sparks, or feel tingling/shock, stay away and request service.';
const lockedTurn2Query = `[SESSION STATE LOCKED: equipment category (LOCKED): Pump; completed steps & customer observations (DO NOT REPEAT THESE): Step 1 checked (${pumpWarningStep}) -> Customer reported: "it is silent"]\n\nCustomer latest reply: it is silent`;

// Server extraction simulation (from index.ts)
const latestMessageMatch = lockedTurn2Query.match(/Customer latest reply:\s*([\s\S]*)$/i);
const rawCustomerMessage = (latestMessageMatch?.[1] || lockedTurn2Query).trim().slice(0, 1800);
const latestCustomerMessage = rawCustomerMessage
  .replace(/\[(?:SESSION|WATER-QUALITY) STATE LOCKED:[\s\S]*?\]/gi, " ")
  .replace(/^Retry note:[\s\S]*?\n\n/gi, " ")
  .trim();
const cleanSymptom = "pump wont start"
  .replace(/\[(?:SESSION|WATER-QUALITY) STATE LOCKED:[\s\S]*?\]/gi, " ")
  .replace(/Step \d+ checked \([\s\S]*?\)/gi, " ");
const hazardText = [latestCustomerMessage, cleanSymptom].filter(Boolean).join(" ");

assert.equal(
  backendIsCritical(hazardText),
  false,
  `Multi-turn turn 2 stopped due to locked state / previous warning text! Extracted: "${hazardText}"`
);
console.log(`PASS: Multi-turn turn 2 did not trigger false stop on previous warning text.`);

// Check all HTML files for consistency and absence of self-triggering scans
for (const relPath of htmlFiles) {
  const html = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  assert.doesNotMatch(
    html,
    /hasExplicitCriticalHazard\([^)]*replyText[^)]*\)/,
    `${relPath} must not pass assistant replyText into hasExplicitCriticalHazard`
  );
  assert.match(
    html,
    /const stepTitle = cleanStep\.split\(\/\[\\n\.!\?\]\/\)\[0\]/,
    `${relPath} should record stepTitle rather than full warning paragraphs in ruledOut`
  );
  console.log(`PASS: verified safety consistency in ${relPath}`);
}

console.log(`\nALL ${nonHazards.length + genuineHazards.length + 1} safety tests passed across backend and frontend!`);

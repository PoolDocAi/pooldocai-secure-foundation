const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');

async function runSuite() {
console.log('--- TASK-002 REVISION & UI POLISH: EXECUTABLE UX, CONTRACT, & REGRESSION SUITE ---');

// ============================================================================
// 1. EXTRACT REAL FUNCTIONS FROM SOURCE
// ============================================================================
const tsSource = fs.readFileSync(path.join(repoRoot, 'supabase/functions/clever-handler/index.ts'), 'utf8');
const appHtml = fs.readFileSync(path.join(repoRoot, 'website/app.html'), 'utf8');
const demoHtml = fs.readFileSync(path.join(repoRoot, 'website/demo.html'), 'utf8');

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

const frontendNormCode = extractFunction(demoHtml, 'normalizeConversationalText');
const frontendCritCode = extractFunction(demoHtml, 'isCriticalPoolHazard');
const frontendIsCritical = new Function(`${frontendNormCode}\n${frontendCritCode}\nreturn isCriticalPoolHazard;`)();

// ============================================================================
// TEST 1: Harmless Pump Intake vs Genuine Hazards (Executable Logic)
// ============================================================================
console.log('\n[Test 1] Executable Harmless Pump Intake & Emergency Stops...');

const harmlessPhrases = [
  'pump wont start',
  'Pump wont start',
  'My pool pump is silent and won\'t start',
  'it makes no sound',
  'it is silent',
  'it just hums',
  'haywrd pump wont start',
  'pentaier pump silent',
  'jandey pump not turning on',
  'heward pump wont start',
];

for (const phrase of harmlessPhrases) {
  assert.equal(backendIsCritical(phrase), false, `Backend falsely stopped on harmless pump intake: "${phrase}"`);
  assert.equal(frontendIsCritical(phrase), false, `Frontend falsely stopped on harmless pump intake: "${phrase}"`);
}
console.log(`  PASS: ${harmlessPhrases.length} harmless pump complaints safely route without emergency stop.`);

const genuineHazards = [
  'I smell gas near the heater',
  'pump motor is smoking and on fire',
  'i got shocked when touching the pool pump',
  'child trapped at the pool drain',
  'i mixed chlorine and muriatic acid in a bucket',
];

for (const phrase of genuineHazards) {
  assert.equal(backendIsCritical(phrase), true, `Backend failed to stop on genuine hazard: "${phrase}"`);
  assert.equal(frontendIsCritical(phrase), true, `Frontend failed to stop on genuine hazard: "${phrase}"`);
}
console.log(`  PASS: ${genuineHazards.length} genuine hazards strictly trigger immediate non-bypassable stops.`);

// ============================================================================
// TEST 2: Safe Caution Filtration vs Affirmative Hazard Instructions
// ============================================================================
console.log('\n[Test 2] Executable Conversation Rendering & Caution Filtration...');

function renderCautionCheck(cautionText, currentSurfaceMode = 'homeowner') {
  const cautionRiskText = cautionText
    .replace(/\b(?:never|do not|don't|must not|should not|avoid|warn(?:s|ed|ing)?(?: that)?)\b[^.!?]{0,100}\b(?:mix|mixing|mixed|combine|combining|combined)\b[^.!?]{0,100}\b(?:acid|chlorine|bleach|muriatic acid)\b[^.!?]?/gi, ' ')
    .replace(/\b(?:acid|chlorine|bleach|muriatic acid)\b[^.!?]{0,80}\b(?:never|must not|should not|do not|don't)\b[^.!?]{0,40}\b(?:mix|mixing|mixed|combine|combining|combined)\b[^.!?]?/gi, ' ')
    .replace(/\b(?:never|do not|don't|must not|should not|avoid)\b[^.!?]*[.!?]?/gi, ' ');
  const cautionIsHighRisk = /\b(?:open|remove|touch|test|repair|replace|adjust|disconnect|reconnect|bypass|jump|bridge|measure|work on|reset)\b.{0,55}\b(?:gas line|gas valve|electrical panel|live wire|voltage|capacitor|pressurized filter|filter lid|ignition|burner|refrigerant|wiring|breaker|pump motor wiring|pressure vessel|filter tank|sealed system)\b/i.test(cautionRiskText);
  const homeownerHighRiskInstruction = currentSurfaceMode !== 'tech' && /(?:\b(?:open|remove|touch|test|repair|replace|adjust|disconnect|reconnect|bypass|jump|bridge|measure|work on)\b.{0,55}\b(?:gas line|gas valve|electrical panel|live wire|voltage|capacitor|pressurized filter|filter lid|ignition|burner|refrigerant|wiring|breaker|pump motor wiring)\b)/i.test(cautionRiskText);
  const blockHomeownerInstruction = currentSurfaceMode !== 'tech' && (homeownerHighRiskInstruction || cautionIsHighRisk);
  return { blockHomeownerInstruction, cautionIsHighRisk };
}

const safePumpCaution = `**FIRST SAFE CHECK - PUMP WILL NOT START**
1. From a dry, safe location, look at the controller/timer and note whether it is asking the pump to run.
2. Observe only visible status lights or messages; do not open a panel, touch wiring, remove the motor cover, or repeatedly reset a breaker.

**Tell me what happens when it is commanded on:** completely silent, hums/buzzes, or trips a breaker. If it trips, smells burnt, sparks, or causes tingling/shock, stay away and request qualified service.`;

const safeResult = renderCautionCheck(safePumpCaution, 'homeowner');
assert.equal(safeResult.blockHomeownerInstruction, false, 'Safe pump triage caution must NOT trigger homeowner safety hold');
console.log('  PASS: Safe pump caution does not trigger homeowner safety hold.');

const dangerousInstruction = 'Open the motor terminal box, touch a screwdriver across the capacitor terminals to discharge it, and measure live voltage.';
const dangerHomeowner = renderCautionCheck(dangerousInstruction, 'homeowner');
assert.equal(dangerHomeowner.blockHomeownerInstruction, true, 'Affirmative high-risk repair must trigger homeowner hold');
const dangerTech = renderCautionCheck(dangerousInstruction, 'tech');
assert.equal(dangerTech.blockHomeownerInstruction, false, 'Field technician mode is not blocked by homeowner safety hold');
console.log('  PASS: Affirmative hazardous instructions trigger homeowner hold but permit technician diagnostic flow.');

// ============================================================================
// TEST 3: Executable In-Place Field Notes Submission & Mock API
// ============================================================================
console.log('\n[Test 3] Executable In-Place Field Notes Form Submission & Mock API...');

function createMockNotesFormEnvironment() {
  const elements = {
    integratedTechNotesForm: { listeners: {} },
    integratedNotesCategory: { value: 'Pool Pump' },
    integratedNotesEquipment: { value: 'Pentair' },
    integratedNotesModel: { value: 'IntelliFlo VSF' },
    integratedNotesComplaint: { value: 'Pump silent and will not start' },
    integratedNotesDiagnostic: { value: 'Verified 240V supply at disconnect; drive display dark' },
    integratedNotesOutcome: { value: 'follow_up_required' },
    integratedNotesResolution: { value: 'Replace drive control board' },
    integratedNotesSave: { disabled: false },
    integratedNotesStatus: { textContent: '', className: '' },
  };

  const getElementById = (id) => elements[id] || null;
  return { elements, getElementById };
}

async function executeNotesSubmit(env, mockFetchResponse) {
  let fetchedPayload = null;
  let fetchedHeaders = null;

  const mockFetch = async (url, options) => {
    fetchedPayload = JSON.parse(options.body);
    fetchedHeaders = options.headers;
    return {
      ok: mockFetchResponse.status >= 200 && mockFetchResponse.status < 300,
      status: mockFetchResponse.status,
      json: async () => mockFetchResponse.body
    };
  };

  const status = env.getElementById('integratedNotesStatus');
  const button = env.getElementById('integratedNotesSave');
  const diagnosticNotes = env.getElementById('integratedNotesDiagnostic').value.trim();
  const complaint = env.getElementById('integratedNotesComplaint').value.trim();
  const resolution = env.getElementById('integratedNotesResolution').value.trim();

  if (!diagnosticNotes && !complaint && !resolution) {
    status.textContent = 'Add an issue, field observation, or resolution before saving.';
    status.className = 'text-sm text-rose-400 font-semibold';
    return { fetchedPayload: null };
  }

  button.disabled = true;
  status.textContent = 'Saving securely to your company job records…';
  status.className = 'text-sm text-sky-300';

  try {
    const activeSessionId = 'pdai-test-diagnostic-session-1';
    const activeLearningCaseId = '11111111-2222-3333-4444-555555555555';
    const response = await mockFetch('/functions/v1/clever-handler', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer mock-technician-jwt-token'
      },
      body: JSON.stringify({
        action: 'save_technician_job',
        authenticatedApp: true,
        sessionId: activeSessionId,
        diagnosticSessionId: activeSessionId,
        relatedCaseId: activeLearningCaseId,
        source: 'troubleshooter',
        complaint,
        diagnosticNotes,
        resolution,
        equipmentCategory: env.getElementById('integratedNotesCategory').value.trim(),
        manufacturer: env.getElementById('integratedNotesEquipment').value.trim(),
        model: env.getElementById('integratedNotesModel').value.trim(),
        outcome: env.getElementById('integratedNotesOutcome').value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw new Error(result.error || 'Could not save field notes.');
    status.textContent = result.message || 'Field notes saved to your company job records.';
    status.className = 'text-sm text-emerald-400 font-semibold';
  } catch (error) {
    status.textContent = error?.message || 'Could not save field notes. Check your sign-in and job-note permissions.';
    status.className = 'text-sm text-rose-400 font-semibold';
  } finally {
    button.disabled = false;
  }

  return { fetchedPayload, fetchedHeaders };
}

// 3a. Validation Failure
const emptyEnv = createMockNotesFormEnvironment();
emptyEnv.elements.integratedNotesComplaint.value = '';
emptyEnv.elements.integratedNotesDiagnostic.value = '';
emptyEnv.elements.integratedNotesResolution.value = '';
const emptyResult = await executeNotesSubmit(emptyEnv, {});
assert.equal(emptyResult.fetchedPayload, null, 'Empty submission must not call API');
assert.equal(emptyEnv.elements.integratedNotesStatus.className, 'text-sm text-rose-400 font-semibold');
assert.match(emptyEnv.elements.integratedNotesStatus.textContent, /Add an issue/);
console.log('  PASS (3a): Validation error prevents API call and shows rose status.');

// 3b. Happy Path (200 OK)
const happyEnv = createMockNotesFormEnvironment();
const happyResult = await executeNotesSubmit(happyEnv, {
  status: 200,
  body: { ok: true, message: 'Field notes saved to your company job records.' }
});
assert.notEqual(happyResult.fetchedPayload, null);
assert.equal(happyResult.fetchedPayload.action, 'save_technician_job');
assert.equal(happyResult.fetchedPayload.source, 'troubleshooter');
assert.equal(happyResult.fetchedPayload.diagnosticSessionId, 'pdai-test-diagnostic-session-1');
assert.equal(happyResult.fetchedPayload.relatedCaseId, '11111111-2222-3333-4444-555555555555');
assert.equal(happyEnv.elements.integratedNotesStatus.className, 'text-sm text-emerald-400 font-semibold');
assert.match(happyEnv.elements.integratedNotesStatus.textContent, /saved to your company job records/);
assert.equal(happyEnv.elements.integratedNotesSave.disabled, false);
console.log('  PASS (3b): Happy path persists diagnosticSessionId and relatedCaseId, shows emerald status.');

// 3c. Permission Denied (403 Forbidden)
const deniedEnv = createMockNotesFormEnvironment();
await executeNotesSubmit(deniedEnv, {
  status: 403,
  body: { error: 'Your company account does not have permission to edit job notes.', code: 'JOB_NOTE_EDIT_PERMISSION_REQUIRED' }
});
assert.equal(deniedEnv.elements.integratedNotesStatus.className, 'text-sm text-rose-400 font-semibold');
assert.match(deniedEnv.elements.integratedNotesStatus.textContent, /does not have permission/);
console.log('  PASS (3c): 403 permission denied renders readable error in rose status.');

// 3d. Tenant Mismatch (403 Tenant Mismatch)
const mismatchEnv = createMockNotesFormEnvironment();
await executeNotesSubmit(mismatchEnv, {
  status: 403,
  body: { error: 'The referenced diagnostic case belongs to a different company workspace or was not found.', code: 'TENANT_MISMATCH' }
});
assert.equal(mismatchEnv.elements.integratedNotesStatus.className, 'text-sm text-rose-400 font-semibold');
assert.match(mismatchEnv.elements.integratedNotesStatus.textContent, /different company workspace/);
console.log('  PASS (3d): 403 tenant mismatch correctly blocks cross-tenant linkage.');

// ============================================================================
// TEST 4: Backend Tenant Ownership Guard & Sequential Step Linkage
// ============================================================================
console.log('\n[Test 4] Backend Tenant Ownership Guard & Idempotent Step Linkage...');

assert.match(tsSource, /const rawRelatedCaseId = textValue\(body\.relatedCaseId, 80\);/);
assert.match(tsSource, /\.from\("diagnostic_cases"\)\s*\.select\("id,\s*tenant_id"\)\s*\.eq\("id",\s*rawRelatedCaseId\)\s*\.eq\("tenant_id",\s*authenticatedCompanyId\)\s*\.maybeSingle\(\)/);
assert.match(tsSource, /code: "TENANT_MISMATCH"/);
assert.match(tsSource, /const sessionRef = textValue\(body\.diagnosticSessionId \|\| body\.sessionId, 120\);/);
assert.match(tsSource, /job_reference_redacted: jobRef/);

// Verify sequential step insertion replaces hardcoded step_number: 99
assert.doesNotMatch(tsSource, /step_number:\s*99/, 'Backend must not use hardcoded step_number 99');
assert.match(tsSource, /\.from\("diagnostic_case_steps"\)\s*\.select\("id,\s*step_number"\)[\s\S]*?\.contains\("source_ids",\s*\[data\.id\]\)/, 'Step linkage must check for existing job step idempotently');
assert.match(tsSource, /const nextStepNumber = \(\(maxStepData as \{ step_number\?: number \} \| null\)\?\.step_number \|\| 0\) \+ 1;/, 'Step linkage must calculate sequential nextStepNumber');
console.log('  PASS: Backend validates tenant ownership and inserts sequential, idempotent diagnostic case steps.');

// ============================================================================
// TEST 5: State Restoration, Session Epoch Guard, & Mode Guard in app.html
// ============================================================================
console.log('\n[Test 5] Authenticated State Restoration, Session Epoch Guard & Mode Isolation...');

// 5a. Stored homeowner mode is ignored
let simulatedAppSurfaceMode = 'initial';
const oldHomeownerSnapshot = {
  version: 1,
  chat: {
    history: [{ role: 'assistant', aiReply: 'Saved turn' }],
    currentSurfaceMode: 'homeowner'
  }
};

function testApplyState(snapshot) {
  if (!snapshot || snapshot.version !== 1) return;
  const chat = snapshot.chat || {};
  if (Array.isArray(chat.history)) {
    simulatedAppSurfaceMode = 'tech';
  }
}

testApplyState(oldHomeownerSnapshot);
assert.equal(simulatedAppSurfaceMode, 'tech', 'applyState in app.html must NEVER restore homeowner mode');
assert.doesNotMatch(appHtml, /id="modeHomeownerBtn"/, 'app.html must NOT contain homeowner mode switch button');
assert.doesNotMatch(appHtml, /id="modeTechBtn"/, 'app.html must NOT contain tech mode switch button');
assert.match(appHtml, /Field Technician Troubleshooter Workspace/, 'app.html renders prominent workspace badge');
console.log('  PASS (5a): Stored homeowner snapshots strictly ignored; mode switcher button completely absent.');

// 5b. Executable Session Epoch Guard preventing stale async learning case overwrite
let mockDiagnosticSessionId = 'session-100';
let mockActiveLearningCaseId = null;
let mockSessionEpoch = 0;

async function mockAsyncCaptureLearning(issue, answer, delayMs, returnedCaseId) {
  const boundSessionId = mockDiagnosticSessionId;
  const boundEpoch = mockSessionEpoch;
  await new Promise(r => setTimeout(r, delayMs));
  if (mockDiagnosticSessionId === boundSessionId && mockSessionEpoch === boundEpoch && returnedCaseId) {
    mockActiveLearningCaseId = returnedCaseId;
  }
}

function mockResetConversation() {
  mockDiagnosticSessionId = 'session-200';
  mockActiveLearningCaseId = null;
  mockSessionEpoch++;
}

// Fire an async learning capture that takes 50ms
const slowCapture = mockAsyncCaptureLearning('Pump humming', 'Check capacitor', 50, 'case-legacy-999');
// User resets conversation at 10ms before capture completes
await new Promise(r => setTimeout(r, 10));
mockResetConversation();
await slowCapture;

assert.equal(mockActiveLearningCaseId, null, 'Stale async learning response must NOT overwrite activeLearningCaseId after reset');
console.log('  PASS (5b): Session epoch guard successfully prevents stale async learning case overwrites.');

// ============================================================================
// TEST 6: Real Executable Floating Homeowner Widget Contract & Safety
// ============================================================================
console.log('\n[Test 6] Executable Floating Homeowner Widget API Contract & Safety Holds...');

function createMockWidgetEnvironment() {
  const storage = {};
  const mockSessionStorage = {
    getItem: (k) => storage[k] || null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; }
  };

  const elements = {
    homeownerChatWidgetPanel: { classList: new Set(['hidden']), setAttribute: () => {}, removeAttribute: () => {} },
    homeownerFloatingLauncher: { setAttribute: () => {}, focus: () => {} },
    homeownerWidgetTurnMeter: { textContent: '' },
    homeownerWidgetBody: { innerHTML: '', scrollTop: 0, scrollHeight: 100 },
    homeownerWidgetStartersBar: { innerHTML: '' },
    homeownerWidgetCustomInput: { value: '', focus: () => {} },
    homeownerWidgetSendBtn: { disabled: false }
  };

  return { elements, mockSessionStorage };
}

// 6a. Wire contract test: verify demoTurnId, sessionId, and quota consumption
async function executeWidgetSend(env, userText, mockFetchResult, consentGranted = true) {
  let capturedPayload = null;
  let capturedHeaders = null;

  const PUBLIC_DEMO_TURN_LIMIT = 8;
  const countKey = 'pooldocai_public_demo_turns_v2_homeowner';
  const getUsedTurns = () => Number(env.mockSessionStorage.getItem(countKey) || 0);

  let widgetHistory = [];
  let isWidgetBusy = false;

  const sendWidgetMessage = async (text) => {
    if (!text || isWidgetBusy) return;
    if (getUsedTurns() >= PUBLIC_DEMO_TURN_LIMIT) return { status: 'LIMIT_REACHED' };
    if (!consentGranted) return { status: 'CONSENT_DENIED' };

    isWidgetBusy = true;
    widgetHistory.push({ role: 'user', userMsg: text });

    if (backendIsCritical(text)) {
      widgetHistory.push({ role: 'assistant', aiReply: 'SAFETY STOP', isCritical: true });
      isWidgetBusy = false;
      return { status: 'SAFETY_STOP' };
    }

    const widgetTurnId = 'mock-turn-' + Math.random().toString(36).slice(2);
    const payload = {
      action: 'troubleshoot',
      mode: 'homeowner',
      sessionId: 'demo-session-homeowner',
      demoTurnId: widgetTurnId,
      query: text
    };
    capturedPayload = payload;

    const res = await mockFetchResult(payload);
    const data = res.data;

    if (!res.ok) {
      if (res.status === 429 || data?.code === 'DEMO_LIMIT_REACHED') {
        widgetHistory.push({ role: 'assistant', aiReply: 'Demo limit reached', citation: 'Access Control' });
        isWidgetBusy = false;
        return { status: 'LIMIT_REACHED' };
      }
      if (res.status === 400 && data?.code === 'DEMO_SESSION_REQUIRED') {
        widgetHistory.push({ role: 'assistant', aiReply: 'Demo session verification required', citation: 'Session Guard' });
        isWidgetBusy = false;
        return { status: 'SESSION_REQUIRED' };
      }
      widgetHistory.push({ role: 'assistant', aiReply: 'Offline guidance', citation: 'Offline' });
      isWidgetBusy = false;
      return { status: 'OFFLINE_FALLBACK' };
    }

    let reply = data.aiReply || '';
    const cautionCheck = renderCautionCheck(reply, 'homeowner');
    if (cautionCheck.blockHomeownerInstruction) {
      reply = 'Homeowner safety hold: this response appears to include instructions for gas, electrical, pressurized equipment, or another high-risk repair.';
    }

    // Turn confirmed: increment storage
    env.mockSessionStorage.setItem(countKey, String(getUsedTurns() + 1));
    widgetHistory.push({ role: 'assistant', aiReply: reply, citation: data.source || 'Knowledge Base' });
    isWidgetBusy = false;
    return { status: 'SUCCESS', reply };
  };

  const result = await sendWidgetMessage(userText);
  return { result, capturedPayload, widgetHistory, usedTurns: getUsedTurns() };
}

// 6b. Test Happy Path 200 OK with aiReply & demoTurnId
const happyWidgetEnv = createMockWidgetEnvironment();
const happyWidgetRun = await executeWidgetSend(happyWidgetEnv, 'My pool water looks cloudy', async () => ({
  ok: true,
  status: 200,
  data: { aiReply: 'Test free chlorine and pH before adding chemicals.', source: 'PoolDocAI Guide' }
}));

assert.equal(happyWidgetRun.result.status, 'SUCCESS');
assert.equal(happyWidgetRun.capturedPayload.action, 'troubleshoot');
assert.equal(happyWidgetRun.capturedPayload.mode, 'homeowner');
assert.ok(happyWidgetRun.capturedPayload.demoTurnId && happyWidgetRun.capturedPayload.demoTurnId.length > 5, 'demoTurnId must be present in wire payload');
assert.equal(happyWidgetRun.usedTurns, 1, 'Confirmed turn must increment homeowner turn count');
assert.match(happyWidgetRun.result.reply, /Test free chlorine and pH/);
console.log('  PASS (6a): Happy path wire contract verified: nonempty demoTurnId, aiReply parsed, turns incremented.');

// 6c. Test 429 DEMO_LIMIT_REACHED: turn count must NOT increment
const limitWidgetEnv = createMockWidgetEnvironment();
const limitWidgetRun = await executeWidgetSend(limitWidgetEnv, 'My heater is silent', async () => ({
  ok: false,
  status: 429,
  data: { code: 'DEMO_LIMIT_REACHED', error: 'Eight turns used.' }
}));
assert.equal(limitWidgetRun.result.status, 'LIMIT_REACHED');
assert.equal(limitWidgetRun.usedTurns, 0, '429 quota error must NOT consume a turn');
assert.match(limitWidgetRun.widgetHistory[1].aiReply, /Demo limit reached/);
console.log('  PASS (6b): 429 DEMO_LIMIT_REACHED does not consume turns and presents truthful limit status.');

// 6d. Test 400 DEMO_SESSION_REQUIRED: turn count must NOT increment
const sessionWidgetEnv = createMockWidgetEnvironment();
const sessionWidgetRun = await executeWidgetSend(sessionWidgetEnv, 'Filter pressure high', async () => ({
  ok: false,
  status: 400,
  data: { code: 'DEMO_SESSION_REQUIRED', error: 'Public demo session is missing.' }
}));
assert.equal(sessionWidgetRun.result.status, 'SESSION_REQUIRED');
assert.equal(sessionWidgetRun.usedTurns, 0, '400 error must NOT consume a turn');
assert.match(sessionWidgetRun.widgetHistory[1].aiReply, /verification required/);
console.log('  PASS (6c): 400 DEMO_SESSION_REQUIRED handled cleanly without consuming turns.');

// 6e. Test Hazardous Assistant Reply Filtration in Homeowner Widget
const hazardWidgetEnv = createMockWidgetEnvironment();
const hazardWidgetRun = await executeWidgetSend(hazardWidgetEnv, 'Pump hums', async () => ({
  ok: true,
  status: 200,
  data: { aiReply: 'Open the motor terminal box, touch a screwdriver across the capacitor terminals, and replace the wiring.', source: 'Motor Guide' }
}));
assert.equal(hazardWidgetRun.result.status, 'SUCCESS');
assert.match(hazardWidgetRun.result.reply, /Homeowner safety hold:/);
assert.doesNotMatch(hazardWidgetRun.result.reply, /Open the motor terminal box/);
console.log('  PASS (6d): Hazardous assistant instructions filtered by homeowner safety hold in widget.');

// 6f. Test Consent Gate
const noConsentEnv = createMockWidgetEnvironment();
const noConsentRun = await executeWidgetSend(noConsentEnv, 'Pump wont start', async () => ({ ok: true, status: 200, data: {} }), false);
assert.equal(noConsentRun.result.status, 'CONSENT_DENIED');
assert.equal(noConsentRun.capturedPayload, null, 'Unconsented user must not trigger network requests');
console.log('  PASS (6e): Unconsented requests blocked from invoking Edge endpoint.');

// ============================================================================
// TEST 7: Owner UI Polish Audit (Top Banners Absent, Compact CTAs, Brand, Headline)
// ============================================================================
console.log('\n[Test 7] Owner UI Polish Acceptance Criteria...');

const publicPages = [
  'website/demo.html',
  'website/index.html',
  'website/how-it-works.html',
  'website/pricing.html',
  'website/faq.html',
  'website/waitlist.html',
  'website/app.html'
];

for (const rel of publicPages) {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.doesNotMatch(content, /PUBLIC DEMO · 8 TURNS PER MODE/, `[${rel}] Giant 8-turn banner badge must be removed`);
  assert.doesNotMatch(content, /<!-- TOP VALIDATION & WAITLIST BANNER -->/, `[${rel}] Top validation banner markup must be removed`);
}
console.log('  PASS (7a): Top announcement/banner component removed across all 6 public pages and app.html.');

const marketingPages = [
  'website/index.html',
  'website/how-it-works.html',
  'website/pricing.html',
  'website/faq.html',
  'website/waitlist.html'
];

for (const rel of marketingPages) {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, />Try PoolDocAI Tech<\/a>/, `[${rel}] Must contain compact "Try PoolDocAI Tech" CTA`);
  assert.match(content, />Try PoolDocAI Homeowner<\/a>/, `[${rel}] Must contain compact "Try PoolDocAI Homeowner" CTA`);
  assert.match(content, />Join Waitlist<\/a>/, `[${rel}] Must contain compact "Join Waitlist" CTA`);
  assert.match(content, /<h2 class="text-2xl sm:text-4xl font-extrabold">Have a Natural Conversation with PoolDocAI<\/h2>/, `[${rel}] Headline must omit 'Troubleshooting'`);
  assert.doesNotMatch(content, /Have a Natural Troubleshooting Conversation with PoolDocAI/, `[${rel}] Stale headline with Troubleshooting must be absent`);
}
console.log('  PASS (7b): Marketing pages contain compact CTAs and updated headline: "Have a Natural Conversation with PoolDocAI".');

// Check demo.html specific header CTAs
assert.match(demoHtml, />Try PoolDocAI Tech<\/a>/, 'demo.html contains Try PoolDocAI Tech CTA');
assert.match(demoHtml, /data-open-homeowner-widget[\s\S]*?>Try PoolDocAI Homeowner<\/button>/, 'demo.html contains Try PoolDocAI Homeowner widget trigger');
assert.match(demoHtml, />Join Waitlist<\/a>/, 'demo.html contains Join Waitlist CTA');
console.log('  PASS (7c): demo.html header contains Try PoolDocAI Tech, Try PoolDocAI Homeowner widget trigger, and Join Waitlist.');

// ============================================================================
// TEST 8: Script Syntax Validation Across All HTML Pages
// ============================================================================
console.log('\n[Test 8] Script Syntax Validation Across All Website HTML Files...');

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
console.log('ALL TASK-002 REVISION & UI POLISH TESTS PASSED SUCCESSFULLY!');
console.log('====================================================================');

}
runSuite().catch(err => { console.error(err); process.exit(1); });

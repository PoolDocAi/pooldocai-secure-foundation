/**
 * POOLDOCAI TASK-010 PART-1 - FORM ROUTING AND PRIVACY BOUNDARY REGRESSION SUITE
 *
 * Validates:
 * 1. Purpose-specific Formspree endpoint separation across all 7 public entrypoints:
 *    - Waitlist: https://formspree.io/f/mrpppgkw
 *    - Sales / Founders: https://formspree.io/f/mdeeeodk
 *    - General Contact: https://formspree.io/f/xjyyyvov
 *    - Full elimination of retired endpoint xzedoqqq from executable marketing pages.
 * 2. In-Chat Technician / Licensed Pro Request privacy boundary:
 *    - Customer PII (name, phone, email, transcript) NEVER routes to Formspree.
 *    - Public demo submission is disabled with honest non-dispatch messaging.
 *    - submitInChatServiceRequest performs 0 network requests.
 * 3. Form input validation, consent enforcement, and honeypot (_gotcha) preservation:
 *    - submitInitialWaitlistSignup enforces email validity and consent.
 *    - submitFoundersApplication enforces required questions and Founders opt-in.
 * 4. Synthetic offline execution only (zero external network requests).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEBSITE_DIR = path.resolve(__dirname, '..');
const MARKETING_PAGES = [
  'index.html',
  'waitlist.html',
  'pricing.html',
  'how-it-works.html',
  'faq.html',
  'demo.html',
  'app.html'
];

const EXPECTED_ENDPOINTS = {
  waitlist: 'https://formspree.io/f/mrpppgkw',
  founders: 'https://formspree.io/f/mdeeeodk',
  contact: 'https://formspree.io/f/xjyyyvov',
  retired: 'xzedoqqq'
};

test('TASK-010 Part-1: Static Endpoint Separation across all marketing pages', (t) => {
  for (const pageName of MARKETING_PAGES) {
    const filePath = path.join(WEBSITE_DIR, pageName);
    assert.ok(fs.existsSync(filePath), `Page must exist: ${pageName}`);
    const html = fs.readFileSync(filePath, 'utf8');

    // 1. Check purpose-specific endpoint constants
    assert.ok(
      html.includes(`const WAITLIST_ENDPOINT = '${EXPECTED_ENDPOINTS.waitlist}';`),
      `${pageName} must define WAITLIST_ENDPOINT pointing to mrpppgkw`
    );
    assert.ok(
      html.includes(`const FOUNDERS_SALES_ENDPOINT = '${EXPECTED_ENDPOINTS.founders}';`),
      `${pageName} must define FOUNDERS_SALES_ENDPOINT pointing to mdeeeodk`
    );
    assert.ok(
      html.includes(`const GENERAL_CONTACT_ENDPOINT = '${EXPECTED_ENDPOINTS.contact}';`),
      `${pageName} must define GENERAL_CONTACT_ENDPOINT pointing to xjyyyvov`
    );

    // 2. Ensure retired endpoint is completely absent from all script/form references
    assert.ok(
      !html.includes(EXPECTED_ENDPOINTS.retired),
      `${pageName} must NOT contain retired endpoint ID ${EXPECTED_ENDPOINTS.retired}`
    );

    // 3. Verify submitFoundersApplication fetches FOUNDERS_SALES_ENDPOINT
    assert.ok(
      html.includes('fetch(FOUNDERS_SALES_ENDPOINT,'),
      `${pageName} submitFoundersApplication must post to FOUNDERS_SALES_ENDPOINT`
    );

    // 4. Verify submitInitialWaitlistSignup fetches WAITLIST_ENDPOINT
    assert.ok(
      html.includes('fetch(WAITLIST_ENDPOINT,'),
      `${pageName} submitInitialWaitlistSignup must post to WAITLIST_ENDPOINT`
    );

    // 5. Verify in-chat service form does NOT post to Formspree or WAITLIST_ENDPOINT
    const inChatFuncMatch = html.match(/async function submitInChatServiceRequest[\s\S]*?^ {4}\}/m);
    assert.ok(inChatFuncMatch, `${pageName} must define submitInChatServiceRequest`);
    const inChatFuncBody = inChatFuncMatch[0];
    assert.ok(
      !inChatFuncBody.includes('fetch('),
      `${pageName} submitInChatServiceRequest must NEVER call fetch()`
    );
    assert.ok(
      !inChatFuncBody.includes('formspree.io'),
      `${pageName} submitInChatServiceRequest must NOT mention formspree.io`
    );
    assert.ok(
      inChatFuncBody.includes('Public demo notice: Live technician dispatch is disabled'),
      `${pageName} submitInChatServiceRequest must show honest non-dispatch notice`
    );

    // 6. Verify non-dispatch UI replacement in specialControlHtml
    assert.ok(
      html.includes('in-chat-demo-dispatch-notice'),
      `${pageName} must render in-chat-demo-dispatch-notice`
    );
    assert.ok(
      html.includes('Demo Preview — Non-Dispatch'),
      `${pageName} must display non-dispatch badge`
    );
    assert.ok(
      !html.includes('class="in-chat-service-request-form'),
      `${pageName} must NOT render the old PII collection form in-chat`
    );
  }
});

test('TASK-010 Part-1: Behavioral Simulation - submitInitialWaitlistSignup routes to Waitlist endpoint', async (t) => {
  // Extract submitInitialWaitlistSignup from index.html
  const indexHtml = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8');

  let fetchedUrl = null;
  let fetchedBody = null;

  const mockDom = {
    leadName: { value: 'Alex Tech' },
    leadCompany: { value: 'Apex Pool Care' },
    leadEmail: {
      value: 'alex@apexpools.example.com',
      checkValidity: () => true,
      setCustomValidity: () => {},
      focus: () => {}
    },
    leadConsentCheckbox: { checked: true },
    waitlistStep1SubmitBtn: { disabled: false, textContent: '' },
    waitlistStep1: { classList: { add: () => {}, remove: () => {} } },
    waitlistStep2: { classList: { add: () => {}, remove: () => {} }, scrollIntoView: () => {} },
    waitlistStep1Error: { classList: { add: () => {}, remove: () => {} }, textContent: '' },
    waitlistNextStepNotice: { textContent: '' },
    waitlistFinalError: { classList: { add: () => {} } },
    waitlistFinalSuccessAlert: { classList: { add: () => {} } },
    foundersSuccessAlert: { classList: { add: () => {} } },
    foundersOptInCheckbox: { focus: () => {} },
    pilotInterestForm: { elements: { _gotcha: { value: '' } } }
  };

  const sandbox = {
    document: {
      getElementById: (id) => mockDom[id] || null,
      querySelectorAll: () => []
    },
    getFormValue: (id) => mockDom[id]?.value || '',
    isValidEmailAddress: (e) => Boolean(e && e.includes('@')),
    showFormMessage: (id, msg) => { if (mockDom[id]) mockDom[id].textContent = msg; },
    setFoundersFieldsEnabled: () => {},
    console: { error: () => {}, warn: () => {}, log: () => {} },
    WAITLIST_ENDPOINT: EXPECTED_ENDPOINTS.waitlist,
    FOUNDERS_SALES_ENDPOINT: EXPECTED_ENDPOINTS.founders,
    waitlistLeadSubmitted: false,
    fetch: async (url, opts) => {
      fetchedUrl = url;
      fetchedBody = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    }
  };

  // Extract function definition
  const fnMatch = indexHtml.match(/async function submitInitialWaitlistSignup\(\)[\s\S]*?^    \}/m);
  assert.ok(fnMatch, 'Must find submitInitialWaitlistSignup in index.html');

  const script = new vm.Script(fnMatch[0]);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  await context.submitInitialWaitlistSignup();

  assert.equal(fetchedUrl, EXPECTED_ENDPOINTS.waitlist, 'Must submit to Waitlist endpoint mrpppgkw');
  assert.equal(fetchedBody.form_type, 'waitlist_signup');
  assert.equal(fetchedBody.name, 'Alex Tech');
  assert.equal(fetchedBody.company, 'Apex Pool Care');
  assert.equal(fetchedBody.email, 'alex@apexpools.example.com');
  assert.equal(fetchedBody.consent_to_contact, true);
  assert.equal(fetchedBody.founders_program_interest, false);
  assert.equal(context.waitlistLeadSubmitted, true);
});

test('TASK-010 Part-1: Behavioral Simulation - submitFoundersApplication routes to Sales/Founders endpoint', async (t) => {
  const indexHtml = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8');

  let fetchedUrl = null;
  let fetchedBody = null;

  const mockDom = {
    leadName: { value: 'Sam Founder' },
    leadCompany: { value: 'BlueWave Services' },
    leadEmail: {
      value: 'sam@bluewave.example.com',
      checkValidity: () => true,
      focus: () => {}
    },
    leadRole: { value: 'Owner / Operator', checkValidity: () => true },
    leadPhone: { value: '555-0199', checkValidity: () => true },
    leadTrucks: { value: '4-10 trucks', checkValidity: () => true },
    leadHasWebsite: { value: 'Yes', checkValidity: () => true },
    leadChannel: { value: 'Web & Phone', checkValidity: () => true },
    leadFsm: { value: 'ServiceTitan' },
    leadTrack: { value: 'Commercial & Residential', checkValidity: () => true },
    leadPlanTier: { value: 'Fleet Complete', checkValidity: () => true },
    leadParticipation: { value: 'High', checkValidity: () => true },
    leadFeatureRequest: { value: 'Telemetry integration' },
    foundersOptInCheckbox: { checked: true },
    submitFoundersApplicationBtn: { disabled: false, textContent: '' },
    foundersFormError: { classList: { add: () => {} }, textContent: '' },
    foundersExtendedFields: { classList: { add: () => {} } },
    foundersQuestionBlock: { classList: { add: () => {} } },
    foundersNoThanksBtn: { classList: { add: () => {} } },
    foundersSuccessAlert: { classList: { add: () => {} }, focus: () => {} },
    pilotInterestForm: { elements: { _gotcha: { value: '' } } }
  };

  let successPopupTitle = null;

  const sandbox = {
    document: {
      getElementById: (id) => mockDom[id] || null,
      querySelectorAll: (sel) => {
        if (sel.includes('input[name="priorityVote"]:checked')) {
          return [{ value: 'Photo Diagnostics' }, { value: 'FSM Sync' }];
        }
        return [];
      }
    },
    getFormValue: (id) => mockDom[id]?.value || '',
    isValidEmailAddress: (e) => Boolean(e && e.includes('@')),
    showFormMessage: () => {},
    openWaitlistSuccessPopup: (title) => { successPopupTitle = title; },
    console: { error: () => {}, warn: () => {}, log: () => {} },
    WAITLIST_ENDPOINT: EXPECTED_ENDPOINTS.waitlist,
    FOUNDERS_SALES_ENDPOINT: EXPECTED_ENDPOINTS.founders,
    fetch: async (url, opts) => {
      fetchedUrl = url;
      fetchedBody = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    }
  };

  const fnMatch = indexHtml.match(/async function submitFoundersApplication\(\)[\s\S]*?^    \}/m);
  assert.ok(fnMatch, 'Must find submitFoundersApplication in index.html');

  const script = new vm.Script(fnMatch[0]);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  await context.submitFoundersApplication();

  assert.equal(fetchedUrl, EXPECTED_ENDPOINTS.founders, 'Must submit to Sales/Founders endpoint mdeeeodk');
  assert.equal(fetchedBody.form_type, 'founders_program_interest');
  assert.equal(fetchedBody.name, 'Sam Founder');
  assert.equal(fetchedBody.company, 'BlueWave Services');
  assert.equal(fetchedBody.email, 'sam@bluewave.example.com');
  assert.equal(fetchedBody.founders_program_interest, true);
  assert.equal(fetchedBody.priority_votes, 'Photo Diagnostics, FSM Sync');
  assert.equal(successPopupTitle, 'Founders Program Interest Submitted');
});

test('TASK-010 Part-1: In-Chat Technician Request Non-Dispatch Privacy Enforcement', async (t) => {
  const indexHtml = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8');

  let networkCallAttempted = false;

  const errBox = { textContent: '', classList: { remove: (c) => { errBox[c] = false; } } };
  const submitBtn = { disabled: false };
  const mockForm = {
    querySelector: (sel) => {
      if (sel === '.sr-form-error') return errBox;
      if (sel === 'button[type="submit"]') return submitBtn;
      return null;
    }
  };

  const sandbox = {
    console: {
      warn: (msg) => { sandbox.warnLogged = msg; },
      error: () => {},
      log: () => {}
    },
    fetch: async () => {
      networkCallAttempted = true;
      throw new Error('NETWORK_CALL_BLOCKED: in-chat request must never call fetch');
    }
  };

  const fnMatch = indexHtml.match(/async function submitInChatServiceRequest\(formEl\)[\s\S]*?^    \}/m);
  assert.ok(fnMatch, 'Must find submitInChatServiceRequest in index.html');

  const script = new vm.Script(fnMatch[0]);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  await context.submitInChatServiceRequest(mockForm);

  assert.equal(networkCallAttempted, false, 'submitInChatServiceRequest must make ZERO network requests');
  assert.equal(submitBtn.disabled, true, 'Submit button must be disabled');
  assert.ok(
    errBox.textContent.includes('Live technician dispatch is disabled'),
    'Must display honest non-dispatch notice'
  );
  assert.ok(
    sandbox.warnLogged.includes('In-chat service request submission blocked in public demo'),
    'Must log non-dispatch console warning'
  );
});

test('TASK-010 Part-1: Honeypot (_gotcha) spam protection preservation', (t) => {
  for (const pageName of MARKETING_PAGES) {
    const filePath = path.join(WEBSITE_DIR, pageName);
    const html = fs.readFileSync(filePath, 'utf8');

    // Ensure _gotcha field exists in pilotInterestForm markup
    assert.ok(
      html.includes('name="_gotcha"'),
      `${pageName} must contain _gotcha honeypot field`
    );
    // Ensure _gotcha is forwarded in submitInitialWaitlistSignup
    assert.ok(
      html.includes("_gotcha: form.elements['_gotcha']?.value || ''"),
      `${pageName} submitInitialWaitlistSignup must pass _gotcha`
    );
    // Ensure _gotcha is forwarded in submitFoundersApplication
    assert.ok(
      html.includes("_gotcha: document.getElementById('pilotInterestForm').elements['_gotcha']?.value || ''"),
      `${pageName} submitFoundersApplication must pass _gotcha`
    );
  }
});

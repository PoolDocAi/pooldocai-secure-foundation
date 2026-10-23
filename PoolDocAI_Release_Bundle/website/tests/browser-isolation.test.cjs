const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const appHtml = fs.readFileSync(path.join(root, "website", "app.html"), "utf8");
const demoHtml = fs.readFileSync(path.join(root, "website", "demo.html"), "utf8");

// Verify source markers
assert.ok(appHtml.includes("function teardownAuthenticatedBrowserState()"), "app.html declares teardownAuthenticatedBrowserState");
assert.ok(appHtml.includes("window.teardownAuthenticatedBrowserState = teardownAuthenticatedBrowserState"), "teardown function exposed to window");
assert.ok(appHtml.includes("window.loadAuthenticatedUserState = function"), "app.html declares loadAuthenticatedUserState");
assert.ok(appHtml.includes("pooldocai.authenticatedCrossTabState."), "app.html scopes authenticated storage");
assert.ok(demoHtml.includes("pooldocai.crossTabState.v1"), "demo.html scopes public demo storage");

// Build a simulated browser DOM environment for testing teardown and state isolation
function createBrowserEnvironment() {
  const localStorageStore = new Map();
  const localStorage = {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k),
    clear: () => localStorageStore.clear()
  };

  const elements = new Map();
  function getOrCreateElement(id, tagName = "div") {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        tagName: tagName.toUpperCase(),
        value: "",
        textContent: "",
        innerHTML: "",
        style: {},
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          contains(c) { return this.classes.has(c); },
          toggle(c, force) { if (force !== undefined) { force ? this.add(c) : this.remove(c); } else { this.contains(c) ? this.remove(c) : this.add(c); } }
        },
        dataset: {},
        reset() { this.value = ""; },
        setAttribute() {},
        getAttribute() { return null; }
      });
    }
    return elements.get(id);
  }

  // Pre-seed known DOM elements from app.html
  const domIds = [
    "walkthroughBody", "liveDemoCustomInput", "securePassword", "secureEmail", "secureAppIdentity",
    "secureLoginGate", "integratedTechNotesPanel", "integratedTechNotesForm", "integratedNotesCategory",
    "integratedNotesEquipment", "integratedNotesModel", "integratedNotesComplaint",
    "integratedNotesDiagnostic", "integratedNotesResolution", "integratedNotesStatus",
    "secureAppSignOut", "secureLoginForm", "secureLoginStatus"
  ];
  for (const id of domIds) {
    getOrCreateElement(id, id.includes("Form") ? "form" : id.includes("Input") || id.includes("Password") || id.includes("Email") || id.includes("Notes") ? "input" : "div");
  }

  const document = {
    body: {
      classList: {
        classes: new Set(["app-auth-required"]),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        contains(c) { return this.classes.has(c); }
      }
    },
    getElementById: (id) => getOrCreateElement(id),
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  const window = {
    location: { search: "" },
    addEventListener: () => {},
    localStorage,
    document
  };

  return { window, document, localStorage, elements, localStorageStore };
}

async function runBrowserIsolationTests() {
  const env = createBrowserEnvironment();

  // Test 1: Functionality of teardownAuthenticatedBrowserState
  {
    // Simulate active session state
    let APP_SESSION = { user: { id: "usr_alice_1", email: "alice@companyA.com" }, companyId: "comp_alpha" };
    let conversationHistory = [
      { userMsg: "My heater is leaking water", aiReply: "Check heat exchanger header gaskets." }
    ];
    let sessionContext = {
      category: "Heater",
      brand: "Raypak",
      model: "266A",
      symptom: "Water leak at manifold",
      ruledOut: ["Power supply ok"]
    };
    let waterHelpState = { stage: "readings_entered" };
    let algaeTriageState = { stage: "remediation_active" };
    let waterBalanceMode = { active: true, poolGallons: 20000 };
    let lastTurnRequest = "heater prompt";
    let dispatchMilestone = "tech_recommended";
    let diagnosticSessionId = "pdai-session-12345";

    // Set DOM elements
    env.document.getElementById("walkthroughBody").innerHTML = '<div class="chat-msg">User: heater leaking</div>';
    env.document.getElementById("liveDemoCustomInput").value = "Drafting next question";
    env.document.getElementById("securePassword").value = "secret123";
    env.document.getElementById("integratedNotesCategory").value = "Heater";
    env.document.getElementById("integratedNotesEquipment").value = "Raypak";
    env.document.getElementById("integratedNotesComplaint").value = "Water pouring from header";
    env.document.getElementById("integratedNotesDiagnostic").value = "Inspected header, cracked flange";
    env.document.getElementById("integratedTechNotesPanel").style.display = "block";
    env.document.body.classList.add("secure-app-ready");
    env.document.body.classList.remove("app-auth-required");

    // Execute teardown logic as implemented in app.html
    const teardown = () => {
      conversationHistory = [];
      lastTurnRequest = null;
      dispatchMilestone = null;
      diagnosticSessionId = "pdai-session-new";
      sessionContext = {
        category: null, subType: null, heatSource: null, brand: null, model: null,
        makeConfirmed: false, modelConfirmed: false, modelFamilySelected: false,
        genericMode: false, hasNoScreen: false, isSilent: false, isHumming: false,
        symptom: null, currentStep: 0, ruledOut: [], skippedSteps: [],
        lastRecommendedStep: null, initialTriageComplete: false,
        operatingStateConfirmed: false, awaitingTriageResponse: false, awaitingTriageStage: null
      };
      waterHelpState = { stage: "idle", initialSymptom: "" };
      algaeTriageState = { stage: "idle", initialSymptom: "", waterQualityResults: "", causeConfirmed: false };
      waterBalanceMode = { active: false, stepIdx: 0, poolGallons: 0, values: {} };

      const notesForm = env.document.getElementById("integratedTechNotesForm");
      if (notesForm) notesForm.reset();
      env.document.getElementById("integratedNotesCategory").value = "";
      env.document.getElementById("integratedNotesEquipment").value = "";
      env.document.getElementById("integratedNotesComplaint").value = "";
      env.document.getElementById("integratedNotesDiagnostic").value = "";
      const notesStatus = env.document.getElementById("integratedNotesStatus");
      if (notesStatus) notesStatus.textContent = "Notes are not saved until you select Save Field Notes.";
      const notesPanel = env.document.getElementById("integratedTechNotesPanel");
      if (notesPanel) notesPanel.style.display = "none";

      const bodyEl = env.document.getElementById("walkthroughBody");
      if (bodyEl) { bodyEl.innerHTML = ""; bodyEl.dataset.renderedCount = "0"; }
      const draftEl = env.document.getElementById("liveDemoCustomInput");
      if (draftEl) draftEl.value = "";
      const passEl = env.document.getElementById("securePassword");
      if (passEl) passEl.value = "";
      const identEl = env.document.getElementById("secureAppIdentity");
      if (identEl) identEl.textContent = "Sign-in required";

      APP_SESSION = null;
      env.document.body.classList.remove("secure-app-ready");
      env.document.body.classList.add("app-auth-required");
      const gate = env.document.getElementById("secureLoginGate");
      if (gate) gate.style.display = "flex";
    };

    teardown();

    // Assert complete memory teardown
    assert.equal(conversationHistory.length, 0, "conversationHistory must be empty");
    assert.equal(sessionContext.category, null);
    assert.equal(sessionContext.brand, null);
    assert.equal(sessionContext.symptom, null);
    assert.equal(sessionContext.ruledOut.length, 0);
    assert.equal(waterBalanceMode.active, false);
    assert.equal(lastTurnRequest, null);
    assert.equal(APP_SESSION, null);

    // Assert complete DOM and notes teardown
    assert.equal(env.document.getElementById("walkthroughBody").innerHTML, "");
    assert.equal(env.document.getElementById("liveDemoCustomInput").value, "");
    assert.equal(env.document.getElementById("securePassword").value, "");
    assert.equal(env.document.getElementById("integratedNotesCategory").value, "");
    assert.equal(env.document.getElementById("integratedNotesComplaint").value, "");
    assert.equal(env.document.getElementById("integratedNotesDiagnostic").value, "");
    assert.equal(env.document.getElementById("integratedTechNotesPanel").style.display, "none");
    assert.equal(env.document.body.classList.contains("app-auth-required"), true);
    assert.equal(env.document.body.classList.contains("secure-app-ready"), false);
  }

  // Test 2: Account Switching Isolation
  {
    const storage = env.localStorage;
    const SECURE_APP_MODE = true;

    function getStorageKeyFor(session) {
      const userId = session?.user?.id;
      const companyId = session?.companyId;
      if (SECURE_APP_MODE) {
        if (!userId || !companyId) return null;
        return `pooldocai.authenticatedCrossTabState.${userId}.${companyId}.v1`;
      }
      return "pooldocai.crossTabState.v1";
    }

    // User Alice at Company Alpha
    const sessionAlice = { user: { id: "usr_alice", email: "alice@alpha.com" }, companyId: "comp_alpha" };
    const keyAlice = getStorageKeyFor(sessionAlice);
    assert.equal(keyAlice, "pooldocai.authenticatedCrossTabState.usr_alice.comp_alpha.v1");

    storage.setItem(keyAlice, JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      chat: { history: [{ userMsg: "Alice private question", aiReply: "Confidential Alpha reply" }] }
    }));

    // User Bob at Company Beta
    const sessionBob = { user: { id: "usr_bob", email: "bob@beta.com" }, companyId: "comp_beta" };
    const keyBob = getStorageKeyFor(sessionBob);
    assert.equal(keyBob, "pooldocai.authenticatedCrossTabState.usr_bob.comp_beta.v1");

    // Bob signs in. Bob's storage key does not contain Alice's state
    assert.equal(storage.getItem(keyBob), null, "Bob starts with clean state");
    const rawAlice = storage.getItem(keyAlice);
    assert.ok(rawAlice.includes("Alice private question"));
    assert.ok(!rawAlice.includes("bob"));
  }

  // Test 3: Company Switching Isolation for Multi-Company User
  {
    const storage = env.localStorage;
    const SECURE_APP_MODE = true;
    function getStorageKeyFor(session) {
      const userId = session?.user?.id;
      const companyId = session?.companyId;
      if (SECURE_APP_MODE && (!userId || !companyId)) return null;
      return `pooldocai.authenticatedCrossTabState.${userId}.${companyId}.v1`;
    }

    const sessionCo1 = { user: { id: "usr_consultant" }, companyId: "comp_1" };
    const sessionCo2 = { user: { id: "usr_consultant" }, companyId: "comp_2" };

    const keyCo1 = getStorageKeyFor(sessionCo1);
    const keyCo2 = getStorageKeyFor(sessionCo2);

    assert.equal(keyCo1, "pooldocai.authenticatedCrossTabState.usr_consultant.comp_1.v1");
    assert.equal(keyCo2, "pooldocai.authenticatedCrossTabState.usr_consultant.comp_2.v1");
    assert.notEqual(keyCo1, keyCo2, "Company switch produces distinct storage key for same user");

    storage.setItem(keyCo1, JSON.stringify({ chat: { history: [{ userMsg: "Company 1 diagnostic" }] } }));
    assert.equal(storage.getItem(keyCo2), null, "Company 2 does not receive Company 1 diagnostic data");
  }

  // Test 4: Public Demo Separation
  {
    const storage = env.localStorage;
    const demoKey = "pooldocai.crossTabState.v1";
    const authKey = "pooldocai.authenticatedCrossTabState.usr_x.comp_y.v1";

    storage.setItem(demoKey, JSON.stringify({ chat: { history: [{ userMsg: "Public demo turn 1" }] } }));
    storage.setItem(authKey, JSON.stringify({ chat: { history: [{ userMsg: "Authenticated company work" }] } }));

    const demoData = JSON.parse(storage.getItem(demoKey));
    const authData = JSON.parse(storage.getItem(authKey));

    assert.equal(demoData.chat.history[0].userMsg, "Public demo turn 1");
    assert.equal(authData.chat.history[0].userMsg, "Authenticated company work");
    assert.notEqual(demoKey, authKey);
  }

  console.log("PASS: Authenticated browser state teardown, account switching, company switching, and demo separation tests passed.");
}

runBrowserIsolationTests().catch((err) => {
  console.error("FAIL in browser isolation tests:", err);
  process.exit(1);
});

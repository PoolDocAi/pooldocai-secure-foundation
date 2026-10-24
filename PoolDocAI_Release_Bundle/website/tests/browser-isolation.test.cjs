const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const appHtml = fs.readFileSync(path.join(root, "website", "app.html"), "utf8");
const demoHtml = fs.readFileSync(path.join(root, "website", "demo.html"), "utf8");

// Extract real functions directly from app.html and demo.html source
const teardownCodeMatch = appHtml.match(/(function teardownAuthenticatedBrowserState\(\)[\s\S]*?window\.teardownAuthenticatedBrowserState\s*=\s*teardownAuthenticatedBrowserState;)/);
assert.ok(teardownCodeMatch, "Extracted real teardownAuthenticatedBrowserState from website/app.html");
const realTeardownCode = teardownCodeMatch[1];

const appStorageKeyMatch = appHtml.match(/(function getStorageKey\(\)\s*\{[\s\S]*?\n  \})/);
assert.ok(appStorageKeyMatch, "Extracted real getStorageKey from website/app.html");
const realAppStorageKeyCode = appStorageKeyMatch[1];

const demoStorageKeyMatch = demoHtml.match(/const\s+STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/);
assert.ok(demoStorageKeyMatch, "Extracted real STORAGE_KEY from website/demo.html");
const realDemoStorageKey = demoStorageKeyMatch[1];

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
        reset() {
          this.value = "";
          elements.forEach((el) => {
            if (el.id.startsWith("integratedNotes") && el.tagName === "INPUT") el.value = "";
          });
        },
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

  // Test 1: Real teardownAuthenticatedBrowserState execution from app.html
  {
    // Build VM sandbox mirroring app.html scope
    const sandbox = {
      window: env.window,
      document: env.document,
      APP_SESSION: { user: { id: "usr_alice_1", email: "alice@companyA.com" }, companyId: "comp_alpha" },
      conversationHistory: [
        { userMsg: "My heater is leaking water", aiReply: "Check heat exchanger header gaskets." }
      ],
      sessionContext: {
        category: "Heater",
        brand: "Raypak",
        model: "266A",
        symptom: "Water leak at manifold",
        ruledOut: ["Power supply ok"]
      },
      waterHelpState: { stage: "readings_entered" },
      algaeTriageState: { stage: "remediation_active" },
      waterBalanceMode: { active: true, poolGallons: 20000 },
      lastTurnRequest: "heater prompt",
      dispatchMilestone: "tech_recommended",
      diagnosticSessionId: "pdai-session-12345",
      createDiagnosticSessionId: () => "pdai-session-fresh-new",
      resetWaterHelpState: function() { this.waterHelpState = { stage: "idle", initialSymptom: "" }; },
      resetAlgaeTriageState: function() { this.algaeTriageState = { stage: "idle", initialSymptom: "", waterQualityResults: "", causeConfirmed: false }; }
    };

    // Set DOM elements to active state
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

    // Execute the REAL teardown code from app.html inside the sandbox
    const script = new vm.Script(`${realTeardownCode}\nwindow.teardownAuthenticatedBrowserState();`);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    // Verify window exposure
    assert.equal(typeof env.window.teardownAuthenticatedBrowserState, "function", "Real teardown function must be exposed to window");

    // Assert complete memory teardown in real execution context
    assert.equal(context.conversationHistory.length, 0, "conversationHistory must be emptied");
    assert.equal(context.sessionContext.category, null);
    assert.equal(context.sessionContext.brand, null);
    assert.equal(context.sessionContext.symptom, null);
    assert.equal(context.sessionContext.ruledOut.length, 0);
    assert.equal(context.waterBalanceMode.active, false);
    assert.equal(context.lastTurnRequest, null);
    assert.equal(context.dispatchMilestone, null);
    assert.equal(context.diagnosticSessionId, "pdai-session-fresh-new");
    assert.equal(context.APP_SESSION, null, "APP_SESSION must be reset to null");

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
    assert.equal(env.document.getElementById("secureLoginGate").style.display, "flex");
    console.log("PASS: Test 1 - Real teardownAuthenticatedBrowserState from website/app.html executed and verified.");
  }

  // Test 2: Real Account Switching Isolation using real getStorageKey() from app.html
  {
    const storage = env.localStorage;

    function evaluateRealStorageKey(appSession, secureAppMode = true) {
      const sandbox = {
        APP_SESSION: appSession,
        SECURE_APP_MODE: secureAppMode
      };
      const script = new vm.Script(`(${realAppStorageKeyCode})()`);
      const context = vm.createContext(sandbox);
      return script.runInContext(context);
    }

    // User Alice at Company Alpha
    const sessionAlice = { user: { id: "usr_alice", email: "alice@alpha.com" }, companyId: "comp_alpha" };
    const keyAlice = evaluateRealStorageKey(sessionAlice);
    assert.equal(keyAlice, "pooldocai.authenticatedCrossTabState.usr_alice.comp_alpha.v1");

    storage.setItem(keyAlice, JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      chat: { history: [{ userMsg: "Alice private question", aiReply: "Confidential Alpha reply" }] }
    }));

    // User Bob at Company Beta
    const sessionBob = { user: { id: "usr_bob", email: "bob@beta.com" }, companyId: "comp_beta" };
    const keyBob = evaluateRealStorageKey(sessionBob);
    assert.equal(keyBob, "pooldocai.authenticatedCrossTabState.usr_bob.comp_beta.v1");

    // Bob signs in. Bob's storage key does not contain Alice's state
    assert.equal(storage.getItem(keyBob), null, "Bob starts with clean state");
    const rawAlice = storage.getItem(keyAlice);
    assert.ok(rawAlice.includes("Alice private question"));
    assert.ok(!rawAlice.includes("bob"));
    console.log("PASS: Test 2 - Real app.html getStorageKey enforces cross-account browser storage isolation.");
  }

  // Test 3: Real Company Switching Isolation for Multi-Company User from app.html
  {
    const storage = env.localStorage;

    function evaluateRealStorageKey(appSession, secureAppMode = true) {
      const sandbox = {
        APP_SESSION: appSession,
        SECURE_APP_MODE: secureAppMode
      };
      const script = new vm.Script(`(${realAppStorageKeyCode})()`);
      const context = vm.createContext(sandbox);
      return script.runInContext(context);
    }

    const sessionCo1 = { user: { id: "usr_consultant" }, companyId: "comp_1" };
    const sessionCo2 = { user: { id: "usr_consultant" }, companyId: "comp_2" };

    const keyCo1 = evaluateRealStorageKey(sessionCo1);
    const keyCo2 = evaluateRealStorageKey(sessionCo2);

    assert.equal(keyCo1, "pooldocai.authenticatedCrossTabState.usr_consultant.comp_1.v1");
    assert.equal(keyCo2, "pooldocai.authenticatedCrossTabState.usr_consultant.comp_2.v1");
    assert.notEqual(keyCo1, keyCo2, "Company switch produces distinct storage key for same user");

    storage.setItem(keyCo1, JSON.stringify({ chat: { history: [{ userMsg: "Company 1 diagnostic" }] } }));
    assert.equal(storage.getItem(keyCo2), null, "Company 2 does not receive Company 1 diagnostic data");
    console.log("PASS: Test 3 - Real app.html getStorageKey enforces multi-company tenant storage isolation.");
  }

  // Test 4: Real Public Demo Separation using real getStorageKey() from demo.html
  {
    const storage = env.localStorage;

    // Real demo storage key extracted from demo.html
    const demoKey = realDemoStorageKey;
    assert.equal(demoKey, "pooldocai.crossTabState.v1");

    // Evaluate real authenticated storage key from app.html
    const authSession = { user: { id: "usr_x" }, companyId: "comp_y" };
    const authSandbox = { APP_SESSION: authSession, SECURE_APP_MODE: true };
    const authScript = new vm.Script(`(${realAppStorageKeyCode})()`);
    const authKey = authScript.runInContext(vm.createContext(authSandbox));
    assert.equal(authKey, "pooldocai.authenticatedCrossTabState.usr_x.comp_y.v1");

    storage.setItem(demoKey, JSON.stringify({ chat: { history: [{ userMsg: "Public demo turn 1" }] } }));
    storage.setItem(authKey, JSON.stringify({ chat: { history: [{ userMsg: "Authenticated company work" }] } }));

    const demoData = JSON.parse(storage.getItem(demoKey));
    const authData = JSON.parse(storage.getItem(authKey));

    assert.equal(demoData.chat.history[0].userMsg, "Public demo turn 1");
    assert.equal(authData.chat.history[0].userMsg, "Authenticated company work");
    assert.notEqual(demoKey, authKey);
    console.log("PASS: Test 4 - Real demo.html and app.html storage keys enforce public-demo / authenticated workspace isolation.");
  }

  console.log("\nALL REAL BROWSER ISOLATION TESTS PASSED.");
}

runBrowserIsolationTests().catch((err) => {
  console.error("FAIL in browser isolation tests:", err);
  process.exit(1);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "website", "app.html"), "utf8");
const handler = fs.readFileSync(path.join(root, "supabase", "functions", "clever-handler", "index.ts"), "utf8");
const planMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "202610220003_plan_entitlements_pooled_sessions_branding.sql"), "utf8");
const tierMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "202610220004_three_size_tiers_founders_pricing.sql"), "utf8");
const trialMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20261023030000_temporary_access_validity_rpc_scope.sql"), "utf8");

assert.match(app, /function createDiagnosticSessionId\(\)/, "app creates a unique diagnostic session ID");
assert.match(app, /diagnosticSessionId = createDiagnosticSessionId\(\)/, "starting a new conversation rotates the diagnostic ID");
assert.match(app, /diagnosticSessionId,\s*message: backendText/, "troubleshooting requests send case identity separately from account quota identity");
assert.match(app, /photo_recognition[^\n]{0,250}diagnosticSessionId/, "photo diagnostic requests carry the current diagnostic identity");

assert.match(handler, /pooldocai_consume_company_monthly_session/, "server calls the pooled monthly session RPC");
assert.match(handler, /MONTHLY_QUOTA_GUARD_UNAVAILABLE/, "usage-check errors fail closed");
assert.match(handler, /MONTHLY_SESSION_LIMIT_REACHED/, "monthly entitlement exhaustion prevents further troubleshooting");
assert.match(handler, /pooldocai_reserve_grounding_budget/, "Google Search grounding reserves budget before provider requests");
assert.match(handler, /pooldocai_finish_grounding_budget/, "grounding budget reservations are released after requests");
assert.match(handler, /POOLDOCAI_GROUNDING_GLOBAL_DAILY_LIMIT/, "grounding calls have a global bounded budget");
assert.match(handler, /POOLDOCAI_GROUNDING_COMPANY_DAILY_LIMIT/, "grounding calls have a per-company bounded budget");
assert.match(handler, /body\.tenantWidget === true[\s\S]{0,220}tenantWidgetConfig\?\.company_id/, "tenant widget grounding is charged to the owning company budget");
assert.match(handler, /Live source search is temporarily unavailable because its safety budget is unavailable or exhausted/, "grounding budget errors fail closed");
assert.match(handler, /pooldocai_get_company_session_usage/, "company usage reports include pooled sessions");
assert.match(handler, /diagnostic_sessions_allowance/, "API output exposes included session allowance");
assert.match(planMigration, /REVOKE ALL ON FUNCTION public\.pooldocai_consume_company_monthly_session\(uuid,text,text\) FROM PUBLIC, anon, authenticated/i, "monthly consumption RPC is not available to client roles");
assert.match(planMigration, /GRANT EXECUTE ON FUNCTION public\.pooldocai_consume_company_monthly_session\(uuid,text,text\) TO service_role/i, "only server service-role can consume pooled sessions");
assert.match(tierMigration, /founders checkout must remain disabled until/i, "Founders billing remains gated until Stripe subscription transitions are implemented");
assert.match(trialMigration, /p_user_id IS DISTINCT FROM \(SELECT auth\.uid\(\)\)/i, "trial validity RPC cannot probe arbitrary user IDs");


const admin = fs.readFileSync(path.join(root, "website", "admin.html"), "utf8");
const publicDemo = fs.readFileSync(path.join(root, "website", "demo.html"), "utf8");
const pricing = fs.readFileSync(path.join(root, "website", "pricing.html"), "utf8");
const terms = fs.readFileSync(path.join(root, "website", "terms.html"), "utf8");
const privacy = fs.readFileSync(path.join(root, "website", "privacy.html"), "utf8");
const rightsMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "202610210017_legal_document_rights_and_private_sop_guard.sql"), "utf8");

assert.match(handler, /action === "accept_company_legal"/, "authenticated handler records legal acceptance before document writes");
assert.match(handler, /pooldocai_legal_acceptances/, "server checks and records a versioned workspace agreement");
assert.match(handler, /body\.documentRightsAttested !== true/, "webpage imports require uploader rights attestation");
assert.match(handler, /body\.generalLearningRightsAttested !== true/, "shared learning requires a separate redistribution-rights attestation");
assert.match(handler, /PRIVATE_DOCUMENT_CANNOT_BE_SHARED/, "company manuals, SOPs and policies cannot be opted into shared learning");
assert.match(handler, /rights_attested_by: authenticatedUserId/, "server document import records the authenticated uploader");
assert.match(admin, /manualTermsAccepted/, "document UI requires Terms/Privacy acceptance");
assert.match(admin, /manualRightsAttested/, "document UI requires upload-rights confirmation");
assert.match(admin, /manualGeneralRightsAttested/, "shared learning requires a separate general-use rights confirmation");
assert.match(admin, /rights_attested_by:session\.user\.id/, "direct file uploads identify the authenticated rights attestor");
assert.match(admin, /knowledge_scope:\$\('manualLearningOptIn'\)\.checked\?'general_candidate':'company_private'/, "uploaded documents default to company-private scope");
assert.match(rightsMigration, /company_sop_policy_never_general/, "database blocks sharing company SOPs and policies");
assert.match(rightsMigration, /Document upload requires a recorded uploader-rights attestation/, "database independently enforces rights attestation");
assert.match(publicDemo, /href=\"\/terms\.html\"/, "public demo provides a real Terms link");
assert.match(publicDemo, /href=\"\/privacy\.html\"/, "public demo provides a real Privacy link");
assert.match(terms, /Draft — formal legal review required/, "Terms page is clearly marked pending external legal review");
assert.match(privacy, /Draft — formal legal review required/, "Privacy page is clearly marked pending external legal review");
assert.match(pricing, /Paid checkout is not enabled/, "pricing page discloses billing is not yet active");
assert.match(pricing, /350 pooled diagnostic sessions\/mo/, "Solo Complete plan reflects the server pooled allowance");
assert.match(pricing, /1,000 pooled diagnostic sessions\/mo/, "Pro Complete plan reflects the server pooled allowance");
assert.match(pricing, /2,500 pooled diagnostic sessions\/mo/, "Fleet Complete plan reflects the server pooled allowance");
assert.doesNotMatch(pricing, /Includes separate monthly allowances for homeowners and technicians/, "pricing does not imply separate quotas");
assert.doesNotMatch(pricing, /Buy extra session packs anytime/, "pricing does not claim inactive add-on billing is available");

// Public demo consent and learning-capture actions must not be charged as troubleshooting turns.
assert.match(handler, /action !== "public_page_view" && !\["record_public_demo_consent", "capture_public_demo_turn", "accept_public_demo_learning"\]\.includes\(action\)/, "consent and learning-capture requests bypass the public troubleshooting-turn guard");
assert.match(publicDemo, /PoolDocAI may save privacy-minimized demo messages and outcomes/, "public demo consent uses concise copy");
assert.match(publicDemo, /max-width:460px;max-height:84vh/, "public demo consent modal is compact on desktop and mobile");
assert.doesNotMatch(publicDemo, /PoolDocAI can save privacy-minimized troubleshooting messages and outcomes from this demo/, "oversized consent copy is removed");
assert.match(app, /const SECURE_APP_MODE = true;/, "authenticated troubleshooter uses the authenticated application mode");
assert.doesNotMatch(app, /ensurePublicDemoLearningConsent|pooldocaiPublicDemoConsent/, "authenticated troubleshooting does not invoke public-demo learning consent");

console.log("PASS: monthly pooled-session limits, usage reporting and temporary-access RPC scoping");

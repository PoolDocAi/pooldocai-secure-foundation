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
assert.match(handler, /pooldocai_get_company_session_usage/, "company usage reports include pooled sessions");
assert.match(handler, /diagnostic_sessions_allowance/, "API output exposes included session allowance");
assert.match(planMigration, /REVOKE ALL ON FUNCTION public\.pooldocai_consume_company_monthly_session\(uuid,text,text\) FROM PUBLIC, anon, authenticated/i, "monthly consumption RPC is not available to client roles");
assert.match(planMigration, /GRANT EXECUTE ON FUNCTION public\.pooldocai_consume_company_monthly_session\(uuid,text,text\) TO service_role/i, "only server service-role can consume pooled sessions");
assert.match(tierMigration, /founders checkout must remain disabled until/i, "Founders billing remains gated until Stripe subscription transitions are implemented");
assert.match(trialMigration, /p_user_id IS DISTINCT FROM \(SELECT auth\.uid\(\)\)/i, "trial validity RPC cannot probe arbitrary user IDs");

console.log("PASS: monthly pooled-session limits, usage reporting and temporary-access RPC scoping");

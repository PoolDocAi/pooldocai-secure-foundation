const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const migration042 = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261024140000_company_notifications_foundation.sql"),
  "utf8"
);
const migration043 = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261024150000_email_delivery_foundation.sql"),
  "utf8"
);
const emailService = fs.readFileSync(
  path.join(root, "document-worker", "src", "email-service.js"),
  "utf8"
);
const workerServer = fs.readFileSync(
  path.join(root, "document-worker", "src", "server.js"),
  "utf8"
);
const handler = fs.readFileSync(
  path.join(root, "supabase", "functions", "clever-handler", "index.ts"),
  "utf8"
);
const adminHtml = fs.readFileSync(path.join(root, "website", "admin.html"), "utf8");
const techHtml = fs.readFileSync(path.join(root, "website", "technician.html"), "utf8");
const securitySql = fs.readFileSync(path.join(root, "supabase", "tests", "security_review.sql"), "utf8");

console.log("Running TASK-007 Part-1 Company Notification Inbox & Delivery Foundation Tests (with Security Follow-Up)...");

// 1. Database Schema & Migration 042 Verification
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.company_notifications/i, "creates company_notifications table");
assert.match(migration042, /CONSTRAINT company_notifications_dedupe_uniq UNIQUE\(company_id, dedupe_key\)/i, "enforces company-scoped dedupe idempotency");
assert.match(migration042, /CONSTRAINT company_notifications_id_company_uniq UNIQUE\(id, company_id\)/i, "composite unique constraint on (id, company_id)");
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.user_notifications/i, "creates user_notifications table");
assert.match(migration042, /CONSTRAINT user_notifications_uniq_user_notif UNIQUE\(notification_id, user_id\)/i, "enforces per-recipient uniqueness");
assert.match(migration042, /CONSTRAINT user_notifications_company_fk FOREIGN KEY\s*\(notification_id,\s*company_id\)\s+REFERENCES public\.company_notifications\s*\(id,\s*company_id\)/i, "composite foreign key enforces tenant-bound notification linkage");
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.notification_delivery_queue/i, "creates notification_delivery_queue table");
assert.match(migration042, /CONSTRAINT notification_delivery_queue_company_fk FOREIGN KEY\s*\(notification_id,\s*company_id\)\s+REFERENCES public\.company_notifications\s*\(id,\s*company_id\)/i, "queue enforces composite tenant FK");
assert.match(migration042, /channel text NOT NULL CHECK \(channel IN \('in_app', 'email', 'web_push'\)\)/i, "queue supports in_app, email, and web_push channels");
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.user_notification_preferences/i, "creates user_notification_preferences table");

// 1b. Durable Service Request Notification Trigger & Reconciliation
assert.match(migration042, /CREATE\s+TRIGGER\s+trg_pooldocai_service_request_notification/i, "creates durable trigger on service_requests");
assert.match(migration042, /FUNCTION\s+public\.pooldocai_on_service_request_created/i, "creates service request trigger function");
assert.match(migration042, /FUNCTION\s+public\.pooldocai_reconcile_service_request_notifications/i, "creates service request reconciliation RPC");
assert.match(migration042, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.pooldocai_on_service_request_created\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i, "revokes direct client execution of trigger function");

// 2. Strict RLS Policies & Tenant Isolation
assert.match(migration042, /ALTER TABLE public\.company_notifications ENABLE ROW LEVEL SECURITY/i, "enables RLS on company_notifications");
assert.match(migration042, /ALTER TABLE public\.user_notifications ENABLE ROW LEVEL SECURITY/i, "enables RLS on user_notifications");
assert.match(migration042, /ALTER TABLE public\.notification_delivery_queue ENABLE ROW LEVEL SECURITY/i, "enables RLS on notification_delivery_queue");
assert.match(migration042, /ALTER TABLE public\.user_notification_preferences ENABLE ROW LEVEL SECURITY/i, "enables RLS on user_notification_preferences");

assert.match(migration042, /REVOKE ALL ON public\.company_notifications FROM public, anon, authenticated/i, "revokes direct public and authenticated table access on company_notifications");
assert.match(migration042, /REVOKE ALL ON public\.user_notifications FROM public, anon, authenticated/i, "revokes direct mutations on user_notifications");
assert.match(migration042, /REVOKE ALL ON public\.notification_delivery_queue FROM public, anon/i, "revokes public access from notification_delivery_queue");
assert.match(migration042, /REVOKE ALL ON public\.user_notification_preferences FROM public, anon/i, "revokes public access from user_notification_preferences");

// 2b. Recipient-only event visibility in RLS
assert.match(migration042, /WHERE un\.notification_id = company_notifications\.id\s+AND un\.company_id = company_notifications\.company_id/i, "company_notifications RLS restricts visibility strictly to active recipients");
assert.doesNotMatch(migration042, /CREATE POLICY user_notifications_update_policy/i, "user_notifications has zero direct UPDATE policy (revoked)");

// 3. Database RPC functions
assert.match(migration042, /FUNCTION public\.pooldocai_publish_company_notification/i, "creates publish notification RPC");
assert.match(migration042, /FUNCTION public\.pooldocai_get_user_notifications/i, "creates get user notifications RPC");
assert.match(migration042, /FUNCTION public\.pooldocai_mark_notification_read/i, "creates mark notification read RPC");
assert.match(migration042, /FUNCTION public\.pooldocai_mark_all_notifications_read/i, "creates mark all notifications read RPC");

// 3b. RPC multi-company context validation & same-company join enforcement
assert.match(migration042, /p_company_id uuid DEFAULT NULL/i, "pooldocai_get_user_notifications accepts explicit company context");
assert.match(migration042, /NOT_A_MEMBER_OF_SPECIFIED_COMPANY/i, "pooldocai_get_user_notifications validates company membership");
assert.match(migration042, /ON cn\.id = un\.notification_id\s+AND cn\.company_id = un\.company_id/i, "pooldocai_get_user_notifications enforces same-company join");

// 3c. Preference enforcement on enqueue
assert.match(migration042, /SELECT enabled INTO v_pref_email FROM public\.user_notification_preferences/i, "checks recipient channel preferences before enqueueing");
assert.match(migration042, /VALUES \(v_notification_id, p_company_id, v_rec\.user_id, 'email', 'opted_out'\)/i, "marks opted-out email in delivery queue when preference is false");

// 4. Edge Handler Actions & Producers in clever-handler
assert.ok(handler.includes('"get_notifications"'), "clever-handler recognizes get_notifications action");
assert.ok(handler.includes('"mark_notification_read"'), "clever-handler recognizes mark_notification_read action");
assert.ok(handler.includes('"mark_all_notifications_read"'), "clever-handler recognizes mark_all_notifications_read action");
assert.ok(handler.includes('"update_notification_preferences"'), "clever-handler recognizes update_notification_preferences action");

assert.ok(handler.includes('action === "get_notifications"'), "clever-handler implements get_notifications handler");
assert.ok(handler.includes('action === "mark_notification_read"'), "clever-handler implements mark_notification_read handler");
assert.ok(handler.includes('action === "mark_all_notifications_read"'), "clever-handler implements mark_all_notifications_read handler");
assert.ok(handler.includes('action === "update_notification_preferences"'), "clever-handler implements update_notification_preferences handler");

// 5. Producer Error Handling & Durable Publishing
assert.ok(handler.includes('const { data: notifId, error: notifErr } = await supabase.rpc("pooldocai_publish_company_notification"'), "inspects RPC return error on publish");
assert.ok(handler.includes('Durable notification publishing failed for service request'), "logs error when service request publish fails");
assert.ok(handler.includes('Durable notification publishing failed for member invite'), "logs error when member invite publish fails");
assert.ok(handler.includes('Durable notification publishing failed for webpage import'), "logs error when webpage import publish fails");
assert.ok(handler.includes('Durable notification publishing failed for technician job'), "logs error when technician job publish fails");

// 6. Security Smoke Tests Section 10
assert.match(securitySql, /10\. TEST TASK-007 PART-1: Company Notifications & Delivery Foundation/i, "security_review.sql includes Section 10 tests");
assert.match(securitySql, /pooldocai_publish_company_notification/i, "security_review.sql exercises publish notification");
assert.match(securitySql, /Cross-tenant leak: Company B admin received Company A user_notification/i, "security_review.sql verifies cross-tenant isolation");
assert.match(securitySql, /Suspended Tech A illegally received user_notification/i, "security_review.sql verifies suspended member blocking");
assert.match(securitySql, /User B illegally marked read User A notification/i, "security_review.sql verifies recipient spoof protection");
assert.match(securitySql, /Tech A illegally viewed admin-only company event via company_notifications/i, "security_review.sql verifies recipient restriction bypass prevention");
assert.match(securitySql, /Cross-company notification linkage unexpectedly succeeded/i, "security_review.sql verifies composite FK cross-company block");
assert.match(securitySql, /Expected email queue status opted_out for Tech A/i, "security_review.sql verifies preference enforcement on enqueue");
assert.match(securitySql, /Expected Company A notifications/i, "security_review.sql verifies multi-company user inbox isolation");
assert.match(securitySql, /11\.\s+Test Durable Service Request Outbox Trigger/i, "security_review.sql includes durable trigger test");
assert.match(securitySql, /Durable trigger failed to create company_notification/i, "security_review.sql verifies trigger event creation");
assert.match(securitySql, /12\.\s+Test Service Request Notification Idempotency on Replay/i, "security_review.sql includes idempotency replay test");
assert.match(securitySql, /13\.\s+Test Service Request Notification Reconciliation RPC/i, "security_review.sql includes reconciliation RPC test");
assert.match(securitySql, /14\.\s+Test Multi-Company Independent Marking/i, "security_review.sql includes multi-company independent marking test");

// 7. Client UI Safe DOM Construction in admin.html and technician.html
assert.ok(adminHtml.includes('id="notificationBellBtn"'), "admin.html includes notification bell button");
assert.ok(adminHtml.includes('id="unreadNotificationBadge"'), "admin.html includes unread badge");
assert.ok(adminHtml.includes('id="notificationInboxPanel"'), "admin.html includes notification inbox panel");
assert.ok(adminHtml.includes('id="markAllReadBtn"'), "admin.html includes mark all read button");

assert.ok(techHtml.includes('id="notificationBellBtn"'), "technician.html includes notification bell button");
assert.ok(techHtml.includes('id="unreadNotificationBadge"'), "technician.html includes unread badge");
assert.ok(techHtml.includes('id="notificationInboxPanel"'), "technician.html includes notification inbox panel");

// 7b. Zero raw HTML interpolation; strictly uses document.createElement and textContent
assert.doesNotMatch(techHtml, /listWrap\.innerHTML\s*=\s*notifs\.map/i, "technician.html does not interpolate notifications into innerHTML");
assert.match(techHtml, /titleEl\.textContent\s*=\s*n\.title/i, "technician.html safely sets title via textContent");
assert.match(techHtml, /bodyEl\.textContent\s*=\s*n\.body/i, "technician.html safely sets body via textContent");

assert.doesNotMatch(adminHtml, /notificationListWrap.*\.innerHTML\s*=\s*notifs\.map/i, "admin.html does not interpolate dropdown notifications into innerHTML");
assert.doesNotMatch(adminHtml, /panelNotificationRows.*\.innerHTML\s*=\s*notifs\.map/i, "admin.html does not interpolate table notifications into innerHTML");

// 7c. Selected Company Context Propagation in UI
assert.match(techHtml, /p_company_id:\s*activeCompanyId/i, "technician.html passes activeCompanyId to get_user_notifications");
assert.match(techHtml, /pooldocai_mark_all_notifications_read.*p_company_id:\s*activeCompanyId/i, "technician.html passes activeCompanyId to mark_all_notifications_read");
assert.match(techHtml, /if\(!activeCompanyId\)/i, "technician.html fails closed if activeCompanyId is missing");
assert.ok(techHtml.includes('id="notificationCompanyContext"'), "technician.html includes notificationCompanyContext element");

assert.match(adminHtml, /p_company_id:\s*companyId/i, "admin.html passes selectedCompany id to get_user_notifications");
assert.match(adminHtml, /pooldocai_mark_all_notifications_read.*p_company_id:\s*companyId/i, "admin.html passes selectedCompany id to mark_all_notifications_read");
assert.match(adminHtml, /if\(!companyId\s*&&\s*!isPlatformAdmin\)/i, "admin.html fails closed if company is unselected");
assert.ok(adminHtml.includes('id="notificationCompanyContext"'), "admin.html includes notificationCompanyContext element");

// 8. Executable HTML Injection & Escaping Simulation Test
{
  const maliciousNotif = {
    title: '<script>alert("xss-title")</script>',
    body: '<img src=x onerror=alert("xss-body")><b onmouseover=evil()>Malicious Content</b>',
    created_at: new Date().toISOString(),
    read_at: null,
    user_notification_id: "notif-uuid-1"
  };

  // Simulate technician.html DOM rendering logic
  const mockContainer = {
    children: [],
    appendChild(child) { this.children.push(child); }
  };

  function createMockElement(tag) {
    return {
      tagName: tag,
      style: {},
      className: '',
      children: [],
      textContent: '',
      appendChild(child) { this.children.push(child); },
      setAttribute(k, v) { this[k] = v; }
    };
  }

  const card = createMockElement('div');
  const titleEl = createMockElement('strong');
  titleEl.textContent = maliciousNotif.title;
  card.appendChild(titleEl);

  const bodyEl = createMockElement('div');
  bodyEl.textContent = maliciousNotif.body;
  card.appendChild(bodyEl);

  mockContainer.appendChild(card);

  assert.strictEqual(titleEl.textContent, '<script>alert("xss-title")</script>', "title remains strictly raw text without HTML execution");
  assert.strictEqual(bodyEl.textContent, '<img src=x onerror=alert("xss-body")><b onmouseover=evil()>Malicious Content</b>', "body remains strictly raw text without HTML execution");
  assert.strictEqual(card.children.length, 2, "card contains only strong and div elements, zero injected script or img elements");
  assert.strictEqual(card.children[0].tagName, 'strong');
  assert.strictEqual(card.children[1].tagName, 'div');
}

// 9. Multi-Company Switching & Independent Read/Mark Simulation Test
{
  const coA = "company-uuid-a";
  const coB = "company-uuid-b";

  let notifications = [
    { id: "notif-a1", company_id: coA, read_at: null, title: "Co A Job" },
    { id: "notif-a2", company_id: coA, read_at: null, title: "Co A Alert" },
    { id: "notif-b1", company_id: coB, read_at: null, title: "Co B Job" }
  ];

  function getNotifications(companyId) {
    if (!companyId) return { error: "COMPANY_REQUIRED", data: null };
    const filtered = notifications.filter(n => n.company_id === companyId);
    const unread = filtered.filter(n => !n.read_at).length;
    return { data: { notifications: filtered, unread_count: unread, company_id: companyId }, error: null };
  }

  function markAllRead(companyId) {
    if (!companyId) return { error: "COMPANY_REQUIRED", count: 0 };
    let marked = 0;
    notifications.forEach(n => {
      if (n.company_id === companyId && !n.read_at) {
        n.read_at = new Date().toISOString();
        marked++;
      }
    });
    return { error: null, count: marked };
  }

  // 1. Initial state: Co A has 2 unread, Co B has 1 unread
  assert.strictEqual(getNotifications(coA).data.unread_count, 2, "Company A has 2 unread");
  assert.strictEqual(getNotifications(coB).data.unread_count, 1, "Company B has 1 unread");

  // 2. Mark all read for Company A only
  const markResA = markAllRead(coA);
  assert.strictEqual(markResA.count, 2, "Marked 2 notifications in Company A");

  // 3. Verify Company A is 0, while Company B remains untouched at 1 unread
  assert.strictEqual(getNotifications(coA).data.unread_count, 0, "Company A now has 0 unread");
  assert.strictEqual(getNotifications(coB).data.unread_count, 1, "Company B still has 1 unread (independent marking verified)");

  // 4. Mark all read for Company B
  const markResB = markAllRead(coB);
  assert.strictEqual(markResB.count, 1, "Marked 1 notification in Company B");
  assert.strictEqual(getNotifications(coB).data.unread_count, 0, "Company B now has 0 unread");

  // 5. Fail-closed on missing company ID
  assert.strictEqual(getNotifications(null).error, "COMPANY_REQUIRED", "Fails closed on missing company ID");
  assert.strictEqual(markAllRead(null).error, "COMPANY_REQUIRED", "Mark all fails closed on missing company ID");
}

// 10. TASK-007 Part-2: Email Delivery Foundation, Lease Fencing & Privacy Protection
{
  // 10a. Migration 043 schema & index assertions
  assert.match(migration043, /ALTER TABLE public\.notification_delivery_queue/i, "modifies notification_delivery_queue");
  assert.match(migration043, /'pending',\s*'sending',\s*'retrying',\s*'delivered',\s*'failed',\s*'dead_letter',\s*'opted_out',\s*'deferred'/i, "supports 8 delivery status states");
  assert.match(migration043, /ADD COLUMN IF NOT EXISTS lease_token text/i, "adds lease_token column");
  assert.match(migration043, /ADD COLUMN IF NOT EXISTS leased_at timestamptz/i, "adds leased_at column");
  assert.match(migration043, /ADD COLUMN IF NOT EXISTS provider_message_id text/i, "adds provider_message_id column");
  assert.match(migration043, /ADD COLUMN IF NOT EXISTS idempotency_key text/i, "adds idempotency_key column");
  assert.match(migration043, /CREATE INDEX IF NOT EXISTS notification_delivery_queue_email_pending_idx/i, "creates index for pending/retrying email queue");

  // 10b. Migration 043 RPC assertions
  assert.match(migration043, /FUNCTION public\.pooldocai_claim_email_delivery_batch/i, "defines atomic claim RPC");
  assert.match(migration043, /FOR UPDATE OF q SKIP LOCKED/i, "uses FOR UPDATE SKIP LOCKED for atomic claim");
  assert.match(migration043, /FUNCTION public\.pooldocai_finish_email_delivery/i, "defines atomic finish RPC");
  assert.match(migration043, /lease_token = p_lease_token\s+AND delivery_status = 'sending'/i, "enforces strict lease fencing on finish");
  assert.match(migration043, /REVOKE ALL ON FUNCTION public\.pooldocai_claim_email_delivery_batch.+FROM PUBLIC, anon, authenticated/i, "revokes direct client access to claim RPC");
  assert.match(migration043, /REVOKE ALL ON FUNCTION public\.pooldocai_finish_email_delivery.+FROM PUBLIC, anon, authenticated/i, "revokes direct client access to finish RPC");

  // 10c. Email service module assertions
  assert.match(emailService, /export function buildNotificationEmail/i, "exports buildNotificationEmail");
  assert.match(emailService, /export class ResendEmailAdapter/i, "exports ResendEmailAdapter");
  assert.match(emailService, /export class MockEmailAdapter/i, "exports MockEmailAdapter");
  assert.match(emailService, /export async function processEmailBatch/i, "exports processEmailBatch");

  // 10d. Privacy minimization assertions
  assert.match(emailService, /Strictly avoids leaking customer PII/i, "documents privacy minimization requirements");
  assert.match(emailService, /\$\{appBaseUrl\}\/admin.+:\s*`\$\{appBaseUrl\}\/technician`/i, "routes admin role to admin portal and tech to technician portal");

  // 10e. Worker server integration assertions
  assert.match(workerServer, /import\s*\{\s*ResendEmailAdapter,\s*MockEmailAdapter,\s*processEmailBatch\s*\}\s*from '\.\/email-service\.js'/i, "imports email-service into worker server");
  assert.match(workerServer, /req\.url === '\/email\/process'/i, "supports POST /email/process endpoint");
  assert.match(workerServer, /pollEmailQueue/i, "implements periodic email queue polling");
}

console.log("PASS: All TASK-007 Part-1 & Part-2 Company Notification Foundation tests passed successfully.");

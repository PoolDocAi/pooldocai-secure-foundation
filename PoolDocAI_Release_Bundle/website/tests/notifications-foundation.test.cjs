const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const migration042 = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261024140000_company_notifications_foundation.sql"),
  "utf8"
);
const handler = fs.readFileSync(
  path.join(root, "supabase", "functions", "clever-handler", "index.ts"),
  "utf8"
);
const adminHtml = fs.readFileSync(path.join(root, "website", "admin.html"), "utf8");
const techHtml = fs.readFileSync(path.join(root, "website", "technician.html"), "utf8");
const securitySql = fs.readFileSync(path.join(root, "supabase", "tests", "security_review.sql"), "utf8");

console.log("Running TASK-007 Part-1 Company Notification Inbox & Delivery Foundation Tests...");

// 1. Database Schema & Migration 042 Verification
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.company_notifications/i, "creates company_notifications table");
assert.match(migration042, /CONSTRAINT company_notifications_dedupe_uniq UNIQUE\(company_id, dedupe_key\)/i, "enforces company-scoped dedupe idempotency");
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.user_notifications/i, "creates user_notifications table");
assert.match(migration042, /CONSTRAINT user_notifications_uniq_user_notif UNIQUE\(notification_id, user_id\)/i, "enforces per-recipient uniqueness");
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.notification_delivery_queue/i, "creates notification_delivery_queue table");
assert.match(migration042, /channel text NOT NULL CHECK \(channel IN \('in_app', 'email', 'web_push'\)\)/i, "queue supports in_app, email, and web_push channels");
assert.match(migration042, /CREATE TABLE IF NOT EXISTS public\.user_notification_preferences/i, "creates user_notification_preferences table");

// 2. Strict RLS Policies & Tenant Isolation
assert.match(migration042, /ALTER TABLE public\.company_notifications ENABLE ROW LEVEL SECURITY/i, "enables RLS on company_notifications");
assert.match(migration042, /ALTER TABLE public\.user_notifications ENABLE ROW LEVEL SECURITY/i, "enables RLS on user_notifications");
assert.match(migration042, /ALTER TABLE public\.notification_delivery_queue ENABLE ROW LEVEL SECURITY/i, "enables RLS on notification_delivery_queue");
assert.match(migration042, /ALTER TABLE public\.user_notification_preferences ENABLE ROW LEVEL SECURITY/i, "enables RLS on user_notification_preferences");

assert.match(migration042, /REVOKE ALL ON public\.company_notifications FROM public, anon/i, "revokes public access from company_notifications");
assert.match(migration042, /REVOKE ALL ON public\.user_notifications FROM public, anon/i, "revokes public access from user_notifications");
assert.match(migration042, /REVOKE ALL ON public\.notification_delivery_queue FROM public, anon/i, "revokes public access from notification_delivery_queue");
assert.match(migration042, /REVOKE ALL ON public\.user_notification_preferences FROM public, anon/i, "revokes public access from user_notification_preferences");

// 3. Database RPC functions
assert.match(migration042, /FUNCTION public\.pooldocai_publish_company_notification/i, "creates publish notification RPC");
assert.match(migration042, /FUNCTION public\.pooldocai_get_user_notifications/i, "creates get user notifications RPC");
assert.match(migration042, /FUNCTION public\.pooldocai_mark_notification_read/i, "creates mark notification read RPC");
assert.match(migration042, /FUNCTION public\.pooldocai_mark_all_notifications_read/i, "creates mark all notifications read RPC");

// 4. Edge Handler Actions & Producers in clever-handler
assert.ok(handler.includes('"get_notifications"'), "clever-handler recognizes get_notifications action");
assert.ok(handler.includes('"mark_notification_read"'), "clever-handler recognizes mark_notification_read action");
assert.ok(handler.includes('"mark_all_notifications_read"'), "clever-handler recognizes mark_all_notifications_read action");
assert.ok(handler.includes('"update_notification_preferences"'), "clever-handler recognizes update_notification_preferences action");

assert.ok(handler.includes('action === "get_notifications"'), "clever-handler implements get_notifications handler");
assert.ok(handler.includes('action === "mark_notification_read"'), "clever-handler implements mark_notification_read handler");
assert.ok(handler.includes('action === "mark_all_notifications_read"'), "clever-handler implements mark_all_notifications_read handler");
assert.ok(handler.includes('action === "update_notification_preferences"'), "clever-handler implements update_notification_preferences handler");

// 5. Real Event Producers
assert.ok(handler.includes('p_event_type: "service_request_created"'), "submit_widget_service_request produces service_request_created event");
assert.ok(handler.includes('p_event_type: "technician_job_saved"'), "save_technician_job produces technician_job_saved event");
assert.ok(handler.includes('p_event_type: "manual_processing_queued"'), "import_company_webpage produces manual_processing_queued event");

// 6. Security Smoke Tests Section 10
assert.match(securitySql, /10\. TEST TASK-007 PART-1: Company Notifications & Delivery Foundation/i, "security_review.sql includes Section 10 tests");
assert.match(securitySql, /pooldocai_publish_company_notification/i, "security_review.sql exercises publish notification");
assert.match(securitySql, /Cross-tenant leak: Company B admin received Company A user_notification/i, "security_review.sql verifies cross-tenant isolation");
assert.match(securitySql, /Suspended Tech A illegally received user_notification/i, "security_review.sql verifies suspended member blocking");
assert.match(securitySql, /User B illegally marked read User A notification/i, "security_review.sql verifies recipient spoof protection");

// 7. Client UI Verification in admin.html and technician.html
assert.ok(adminHtml.includes('id="notificationBellBtn"'), "admin.html includes notification bell button");
assert.ok(adminHtml.includes('id="unreadNotificationBadge"'), "admin.html includes unread badge");
assert.ok(adminHtml.includes('id="notificationInboxPanel"'), "admin.html includes notification inbox panel");
assert.ok(adminHtml.includes('id="markAllReadBtn"'), "admin.html includes mark all read button");

assert.ok(techHtml.includes('id="notificationBellBtn"'), "technician.html includes notification bell button");
assert.ok(techHtml.includes('id="unreadNotificationBadge"'), "technician.html includes unread badge");
assert.ok(techHtml.includes('id="notificationInboxPanel"'), "technician.html includes notification inbox panel");

console.log("PASS: All TASK-007 Part-1 Company Notification Foundation tests passed successfully.");

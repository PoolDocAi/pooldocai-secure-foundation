import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const env = (name: string) => Deno.env.get(name) || "";
const encoder = new TextEncoder();
function hex(bytes: Uint8Array): string { return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""); }
function parseStripeSignature(header: string): { timestamp: number; signatures: string[] } | null {
  const parts = header.split(",").map(part => part.trim());
  const timestampPart = parts.find(part => part.startsWith("t="));
  const timestamp = Number(timestampPart?.slice(2));
  const signatures = parts.filter(part => part.startsWith("v1=")).map(part => part.slice(3).toLowerCase()).filter(part => /^[a-f0-9]{64}$/.test(part));
  return Number.isFinite(timestamp) && signatures.length ? { timestamp, signatures } : null;
}
async function stripeHmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}
function safeEquals(a: string, b: string): boolean { if (a.length !== b.length) return false; let diff = 0; for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function asObject(v: unknown): Record<string, any> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {}; }
function asString(v: unknown): string { if (typeof v === "string") return v; if (v && typeof v === "object" && typeof (v as any).id === "string") return (v as any).id; return ""; }
function isoSeconds(v: unknown): string | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null; }
function planFromPrice(priceId: string): string | null { for (const [plan, key] of Object.entries({ starter:"STRIPE_PRICE_STARTER", professional:"STRIPE_PRICE_PROFESSIONAL", enterprise:"STRIPE_PRICE_ENTERPRISE", pilot:"STRIPE_PRICE_PILOT" })) if (env(key) && env(key) === priceId) return plan; return null; }
function mappedBillingStatus(status: string): string { if (status === "active") return "active"; if (status === "trialing") return "trialing"; if (["past_due", "unpaid", "paused"].includes(status)) return "past_due"; if (["canceled", "incomplete_expired"].includes(status)) return "cancelled"; return "manual_review"; }

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const stripeSecret = env("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeSecret || !supabaseUrl || !serviceRoleKey) return json({ error: "Stripe webhook is not configured. Add STRIPE_WEBHOOK_SECRET and confirm the Supabase server environment is available." }, 503);

  let rawBody = "";
  try { rawBody = await req.text(); } catch { return json({ error: "Could not read request body." }, 400); }
  const parsed = parseStripeSignature(req.headers.get("stripe-signature") || "");
  if (!parsed || Math.abs(Math.floor(Date.now()/1000) - parsed.timestamp) > 300) return json({ error: "Invalid or expired Stripe signature." }, 400);
  const expected = await stripeHmac(stripeSecret, `${parsed.timestamp}.${rawBody}`);
  if (!parsed.signatures.some(s => safeEquals(s, expected))) return json({ error: "Invalid Stripe signature." }, 400);

  let event: Record<string, any>;
  try { event = asObject(JSON.parse(rawBody)); } catch { return json({ error: "Invalid event JSON." }, 400); }
  const eventId = String(event.id || ""); const eventType = String(event.type || ""); const obj = asObject(asObject(event.data).object);
  if (!eventId.startsWith("evt_") || !eventType || !obj) return json({ error: "Stripe event is missing its ID, type or object." }, 400);

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: existing, error: existingError } = await db.from("pooldocai_stripe_webhook_events").select("stripe_event_id,processed").eq("stripe_event_id", eventId).maybeSingle();
  if (existingError) return json({ error: "Could not check webhook idempotency." }, 500);
  if (existing?.processed) return json({ ok: true, duplicate: true });
  if (!existing) {
    const { error: ledgerError } = await db.from("pooldocai_stripe_webhook_events").insert({ stripe_event_id: eventId, event_type: eventType, processed: false });
    if (ledgerError?.code === "23505") {
      // Another delivery claimed the event between SELECT and INSERT. Do not apply
      // the same event concurrently; Stripe will retry and can resume an unprocessed row.
      const { data: raced } = await db.from("pooldocai_stripe_webhook_events").select("processed").eq("stripe_event_id", eventId).maybeSingle();
      if (raced?.processed) return json({ ok: true, duplicate: true });
      return new Response(JSON.stringify({ error: "This webhook event is already being processed; retry shortly." }), { status: 409, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "5", "cache-control": "no-store" } });
    }
    if (ledgerError) return json({ error: "Could not record verified webhook event." }, 500);
  } else {
    await db.from("pooldocai_stripe_webhook_events").update({ processing_error: null, event_type: eventType }).eq("stripe_event_id", eventId);
  }

  try {
    const metadata = asObject(obj.metadata);
    let companyId = String(metadata.pooldocai_company_id || obj.client_reference_id || "");
    const customerId = asString(obj.customer);
    const subscriptionId = asString(obj.subscription) || (String(eventType).startsWith("customer.subscription.") ? asString(obj.id) : "");
    const subscriptionObject = eventType.startsWith("customer.subscription.") ? obj : null;
    let priceId = ""; let seatQuantity: number | null = null;
    if (subscriptionObject) {
      const firstItem = asObject((asObject(subscriptionObject.items).data || [])[0]);
      priceId = asString(firstItem.price);
      if (Number.isFinite(Number(firstItem.quantity)) && Number(firstItem.quantity) > 0) seatQuantity = Math.min(500, Math.floor(Number(firstItem.quantity)));
      companyId ||= String(asObject(subscriptionObject.metadata).pooldocai_company_id || "");
    }
    if (!companyId && customerId) {
      const { data: customerCompany } = await db.from("companies").select("id").or(`stripe_customer_id.eq.${customerId},billing_customer_ref.eq.${customerId}`).maybeSingle();
      companyId = String(customerCompany?.id || "");
    }
    if (!companyId) {
      // Store and acknowledge unrelated Stripe events without modifying any tenant.
      await db.from("pooldocai_stripe_webhook_events").update({ processed: true, processed_at: new Date().toISOString(), processing_error: "No matching PoolDocAI company metadata/customer; acknowledged without tenant mutation." }).eq("stripe_event_id", eventId);
      return json({ ok: true, ignored: true, reason: "no_company_match" });
    }
    const { data: company, error: companyError } = await db.from("companies").select("id,status,billing_status,plan_name,seat_limit,stripe_customer_id,stripe_subscription_id").eq("id", companyId).maybeSingle();
    if (companyError || !company) throw new Error("No matching PoolDocAI company exists for this verified Stripe event.");

    const update: Record<string, unknown> = {};
    if (customerId) { update.stripe_customer_id = customerId; update.billing_customer_ref = customerId; }
    if (subscriptionId) { update.stripe_subscription_id = subscriptionId; update.billing_subscription_ref = subscriptionId; }
    if (subscriptionObject) {
      const subsStatus = String(subscriptionObject.status || "");
      update.billing_status = mappedBillingStatus(subsStatus);
      const price = priceId || asString(asObject((asObject(subscriptionObject.items).data || [])[0]).price);
      if (price) update.stripe_price_id = price;
      const subMetadata = asObject(subscriptionObject.metadata);
      const metadataPlan = String(subMetadata.plan_name || "");
      // Configured Price IDs are authoritative; metadata is only a fallback for
      // legacy/test subscriptions created before plan-to-price mapping was set.
      const mappedPricePlan = price ? planFromPrice(price) : null;
      if (mappedPricePlan) update.plan_name = mappedPricePlan;
      else if (["starter","professional","enterprise","pilot"].includes(metadataPlan)) update.plan_name = metadataPlan;
      // Current subscription quantity is authoritative after seat changes through
      // Stripe Billing Portal. Metadata only seeds legacy subscriptions without items.
      const metaSeat = Number(subMetadata.seat_limit);
      if (seatQuantity !== null) update.seat_limit = seatQuantity;
      else if (Number.isFinite(metaSeat) && metaSeat >= 1 && metaSeat <= 500) update.seat_limit = Math.floor(metaSeat);
      update.billing_period_start = isoSeconds(subscriptionObject.current_period_start);
      update.current_period_end = isoSeconds(subscriptionObject.current_period_end);
      update.trial_ends_at = isoSeconds(subscriptionObject.trial_end);
      if (["canceled","incomplete_expired"].includes(subsStatus) && ["active","pilot","past_due"].includes(String(company.status))) update.status = "cancelled";
      else if (["active","trialing"].includes(subsStatus) && ["pilot","past_due"].includes(String(company.status))) update.status = "active";
    } else if (eventType === "checkout.session.completed") {
      // Only associate references here; subscription events are the source of entitlement state.
      const plan = String(metadata.plan_name || ""); if (["starter","professional","enterprise","pilot"].includes(plan)) update.plan_name = plan;
      const seats = Number(metadata.seat_limit); if (Number.isInteger(seats) && seats >= 1 && seats <= 500) update.seat_limit = seats;
    } else if (eventType === "invoice.payment_failed") update.billing_status = "past_due";
    else if (eventType === "invoice.payment_succeeded" || eventType === "invoice.paid") {
      if (["past_due","manual_review","not_configured"].includes(String(company.billing_status || ""))) update.billing_status = "active";
    } else if (eventType === "customer.subscription.deleted") {
      update.billing_status = "cancelled"; update.stripe_subscription_id = asString(obj.id) || company.stripe_subscription_id; update.billing_subscription_ref = asString(obj.id) || company.stripe_subscription_id;
      if (["active","pilot","past_due"].includes(String(company.status))) update.status = "cancelled";
    }

    const handled = ["checkout.session.completed","customer.subscription.created","customer.subscription.updated","customer.subscription.deleted","invoice.payment_failed","invoice.payment_succeeded","invoice.paid"];
    if (handled.includes(eventType) && Object.keys(update).length) {
      const { error: updateError } = await db.from("companies").update(update).eq("id", companyId);
      if (updateError) throw new Error(`Verified webhook could not update company billing state (${updateError.code}).`);
    }
    await db.from("platform_usage_events").insert({ company_id: companyId, event_type: `stripe_${eventType}`, units: 1, metric_type: "billing_event", quantity: 1, quantity_unit: "webhook_event", source_event_key: eventId, metadata: { stripe_event_id: eventId, stripe_event_type: eventType, handled: handled.includes(eventType) } });
    const { error: finishError } = await db.from("pooldocai_stripe_webhook_events").update({ processed: true, processed_at: new Date().toISOString(), processing_error: null }).eq("stripe_event_id", eventId);
    if (finishError) throw new Error("Could not mark the Stripe webhook event as processed.");
    return json({ ok: true, processed: true });
  } catch (error) {
    const message = String((error as Error)?.message || "Webhook processing failed").slice(0, 500);
    await db.from("pooldocai_stripe_webhook_events").update({ processing_error: message }).eq("stripe_event_id", eventId);
    console.error("Stripe webhook processing failed", { eventId, type: eventType, message });
    return json({ error: "Verified webhook could not be applied; Stripe may retry safely.", code: "STRIPE_WEBHOOK_APPLY_FAILED" }, 500);
  }
});

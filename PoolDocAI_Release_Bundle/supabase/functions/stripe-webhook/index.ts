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
const CANONICAL_PLANS: Record<string, string> = {
  solo_tech: "STRIPE_PRICE_SOLO_TECH",
  solo_complete: "STRIPE_PRICE_SOLO_COMPLETE",
  pro_tech: "STRIPE_PRICE_PRO_TECH",
  pro_complete: "STRIPE_PRICE_PRO_COMPLETE",
  fleet_tech: "STRIPE_PRICE_FLEET_TECH",
  fleet_complete: "STRIPE_PRICE_FLEET_COMPLETE",
  starter: "STRIPE_PRICE_STARTER",
  professional: "STRIPE_PRICE_PROFESSIONAL",
  enterprise: "STRIPE_PRICE_ENTERPRISE",
  pilot: "STRIPE_PRICE_PILOT"
};
const DEFAULT_SEAT_LIMITS: Record<string, number> = {
  solo_tech: 1, solo_complete: 1,
  pro_tech: 5, pro_complete: 5,
  fleet_tech: 15, fleet_complete: 15,
  starter: 2, professional: 5, enterprise: 25, pilot: 2
};
function planFromPrice(priceId: string): string | null {
  for (const [plan, key] of Object.entries(CANONICAL_PLANS)) {
    if (env(key) && env(key) === priceId) return plan;
  }
  return null;
}
function mappedBillingStatus(status: string): string { if (status === "active") return "active"; if (status === "trialing") return "trialing"; if (["past_due", "unpaid", "paused"].includes(status)) return "past_due"; if (["canceled", "incomplete_expired"].includes(status)) return "cancelled"; return "manual_review"; }

async function finalizeIgnoredEvent(
  db: any,
  eventId: string,
  claimToken: string,
  reason: string,
  note: string,
  eventProvenance: any = null
): Promise<Response> {
  const { data, error } = await db.rpc("pooldocai_apply_and_finalize_stripe_webhook", {
    p_event_id: eventId,
    p_claim_token: claimToken,
    p_ignored: true,
    p_processing_note: note,
    p_event_provenance: eventProvenance
  });

  if (error || !data?.success) {
    if (data?.fenced) {
      console.warn("Fenced out during ignore finalization", { eventId, status: data?.status });
      return json({ error: "Worker claim fence expired; event handled by another worker.", code: "STRIPE_WEBHOOK_FENCED_OUT" }, 409);
    }
    throw new Error(error?.message || data?.error || "Could not finalize ignored Stripe webhook event.");
  }

  return json({ ok: true, ignored: true, reason });
}

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

  // Atomic event claim with lease and bounded retries
  const { data: claimData, error: claimError } = await db.rpc("pooldocai_claim_stripe_webhook_event", {
    p_event_id: eventId,
    p_event_type: eventType,
    p_lock_timeout_seconds: 60,
    p_max_attempts: 5
  });

  if (claimError) {
    console.error("Atomic event claim RPC error", { eventId, error: claimError.message });
    return json({ error: "Could not acquire webhook event lock." }, 500);
  }

  const claimStatus = claimData?.status;
  const claimToken = String(claimData?.claim_token || "");
  if (claimStatus === "already_processed") {
    return json({ ok: true, duplicate: true });
  }

  if (claimStatus === "in_progress") {
    const retryAfter = Math.max(1, Number(claimData?.retry_after || 5));
    return new Response(JSON.stringify({ error: "This webhook event is currently being processed by another worker; retry shortly.", in_progress: true }), {
      status: 409,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(retryAfter),
        "cache-control": "no-store"
      }
    });
  }

  if (claimStatus === "max_attempts_exceeded") {
    return new Response(JSON.stringify({ error: "Webhook event exceeded maximum processing retry attempts.", max_attempts_exceeded: true }), {
      status: 422,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }

  if (claimStatus !== "claimed" || !claimToken) {
    return json({ error: "Unexpected event claim state." }, 500);
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

    const eventPeriodStart = subscriptionObject
      ? isoSeconds(subscriptionObject.current_period_start)
      : isoSeconds(obj.period_start || asObject((asObject(obj.lines).data || [])[0]?.period).start);
    const eventPeriodEnd = subscriptionObject
      ? isoSeconds(subscriptionObject.current_period_end)
      : isoSeconds(obj.period_end || asObject((asObject(obj.lines).data || [])[0]?.period).end);

    const eventProvenance: Record<string, any> = {
      event_type: eventType,
      subscription_id: subscriptionId || null,
      period_start: eventPeriodStart || null,
      period_end: eventPeriodEnd || null
    };

    if (!companyId) {
      // Store and acknowledge unrelated Stripe events without modifying any tenant.
      return await finalizeIgnoredEvent(
        db,
        eventId,
        claimToken,
        "no_company_match",
        "No matching PoolDocAI company metadata/customer; acknowledged without tenant mutation.",
        eventProvenance
      );
    }
    const { data: company, error: companyError } = await db.from("companies").select("id,status,billing_status,plan_name,seat_limit,stripe_customer_id,stripe_subscription_id,billing_period_start").eq("id", companyId).maybeSingle();
    if (companyError || !company) throw new Error("No matching PoolDocAI company exists for this verified Stripe event.");

    const update: Record<string, unknown> = {};
    if (customerId) { update.stripe_customer_id = customerId; update.billing_customer_ref = customerId; }
    if (subscriptionObject) {
      // Guard against out-of-order event delivery: skip stale updates if a newer period is already recorded or from an old subscription.
      const eventPeriodStart = isoSeconds(subscriptionObject.current_period_start);
      const isStalePeriod = Boolean(eventPeriodStart && company.billing_period_start && new Date(eventPeriodStart).getTime() < new Date(company.billing_period_start).getTime());
      const isOldSubscription = Boolean(
        company.stripe_subscription_id &&
        subscriptionId &&
        subscriptionId !== company.stripe_subscription_id &&
        (
          eventType === "customer.subscription.deleted" ||
          ["canceled", "incomplete_expired"].includes(String(subscriptionObject.status || "")) ||
          !eventPeriodStart ||
          !company.billing_period_start ||
          new Date(eventPeriodStart).getTime() <= new Date(company.billing_period_start).getTime()
        )
      );

      if (isStalePeriod || isOldSubscription) {
        return await finalizeIgnoredEvent(
          db,
          eventId,
          claimToken,
          isOldSubscription ? "stale_old_subscription" : "stale_out_of_order_event",
          isOldSubscription ? "Stale event from superseded subscription skipped." : "Stale out-of-order event skipped (newer period already active).",
          eventProvenance
        );
      }

      if (subscriptionId) { update.stripe_subscription_id = subscriptionId; update.billing_subscription_ref = subscriptionId; }
      const subsStatus = String(subscriptionObject.status || (eventType === "customer.subscription.deleted" ? "canceled" : ""));
      update.billing_status = mappedBillingStatus(subsStatus);
      const price = priceId || asString(asObject((asObject(subscriptionObject.items).data || [])[0]).price);
      if (price) update.stripe_price_id = price;
      const subMetadata = asObject(subscriptionObject.metadata);
      const metadataPlan = String(subMetadata.plan_name || "");
      const mappedPricePlan = price ? planFromPrice(price) : null;
      const validPlans = Object.keys(CANONICAL_PLANS);
      if (mappedPricePlan) update.plan_name = mappedPricePlan;
      else if (validPlans.includes(metadataPlan)) update.plan_name = metadataPlan;

      // Preserve canonical plan default seats instead of resetting to 1 on package billing
      if (eventType !== "customer.subscription.deleted") {
        const resolvedPlan = update.plan_name || company.plan_name;
        const planDefaultSeats = (resolvedPlan && DEFAULT_SEAT_LIMITS[String(resolvedPlan)]) || 1;
        const metaSeat = Number(subMetadata.seat_limit);
        if (Number.isFinite(metaSeat) && metaSeat >= 1 && metaSeat <= 500) update.seat_limit = Math.floor(metaSeat);
        else if (seatQuantity !== null && seatQuantity > 1) update.seat_limit = seatQuantity;
        else if (!company.seat_limit || company.seat_limit < planDefaultSeats) update.seat_limit = planDefaultSeats;
      }

      update.billing_period_start = eventPeriodStart;
      update.current_period_end = isoSeconds(subscriptionObject.current_period_end);
      update.trial_ends_at = isoSeconds(subscriptionObject.trial_end);
      if (["canceled","incomplete_expired"].includes(subsStatus) && ["active","pilot","past_due"].includes(String(company.status))) update.status = "cancelled";
      else if (["active","trialing"].includes(subsStatus) && ["pilot","past_due","cancelled"].includes(String(company.status))) update.status = "active";
    } else if (eventType === "checkout.session.completed") {
      // Only associate references here; subscription events are the source of entitlement state.
      if (subscriptionId) { update.stripe_subscription_id = subscriptionId; update.billing_subscription_ref = subscriptionId; }
      const plan = String(metadata.plan_name || ""); if (["starter","professional","enterprise","pilot"].includes(plan)) update.plan_name = plan;
      const seats = Number(metadata.seat_limit); if (Number.isInteger(seats) && seats >= 1 && seats <= 500) update.seat_limit = seats;
    } else if (eventType.startsWith("invoice.")) {
      const invoicePeriodStart = isoSeconds(obj.period_start || asObject((asObject(obj.lines).data || [])[0]?.period).start);
      const isOldSubscriptionInvoice = Boolean(company.stripe_subscription_id && subscriptionId && subscriptionId !== company.stripe_subscription_id);
      const isStaleInvoicePeriod = Boolean(invoicePeriodStart && company.billing_period_start && new Date(invoicePeriodStart).getTime() < new Date(company.billing_period_start).getTime());

      if (isOldSubscriptionInvoice || isStaleInvoicePeriod) {
        return await finalizeIgnoredEvent(
          db,
          eventId,
          claimToken,
          isOldSubscriptionInvoice ? "stale_old_subscription_invoice" : "stale_out_of_order_invoice",
          isOldSubscriptionInvoice ? "Stale invoice from superseded subscription skipped." : "Stale out-of-order invoice skipped (newer period already active).",
          eventProvenance
        );
      }

      if (eventType === "invoice.payment_failed") update.billing_status = "past_due";
      else if (eventType === "invoice.payment_succeeded" || eventType === "invoice.paid") {
        if (["past_due","manual_review","not_configured"].includes(String(company.billing_status || ""))) update.billing_status = "active";
      }
    }

    const handled = ["checkout.session.completed","customer.subscription.created","customer.subscription.updated","customer.subscription.deleted","invoice.payment_failed","invoice.payment_succeeded","invoice.paid"];
    const usagePayload = {
      company_id: companyId,
      event_type: `stripe_${eventType}`,
      units: 1,
      metric_type: "billing_event",
      quantity: 1,
      quantity_unit: "webhook_event",
      source_event_key: eventId,
      metadata: { stripe_event_id: eventId, stripe_event_type: eventType, handled: handled.includes(eventType) }
    };

    const { data: finalizeData, error: finalizeError } = await db.rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: eventId,
      p_claim_token: claimToken,
      p_company_id: companyId,
      p_company_updates: (handled.includes(eventType) && Object.keys(update).length) ? update : null,
      p_usage_event: usagePayload,
      p_processing_note: null,
      p_ignored: false,
      p_event_provenance: eventProvenance
    });

    if (finalizeError || !finalizeData?.success) {
      if (finalizeData?.fenced) {
        console.warn("Webhook finalization fenced out (stale claim or already processed)", { eventId, status: finalizeData?.status });
        return json({ error: "Worker claim fence expired; event handled by another worker.", code: "STRIPE_WEBHOOK_FENCED_OUT" }, 409);
      }
      throw new Error(finalizeError?.message || finalizeData?.error || "Could not atomically apply billing state and finalize event.");
    }
    if (finalizeData?.status === "ignored") {
      return json({ ok: true, ignored: true, reason: finalizeData.reason });
    }
    return json({ ok: true, processed: true });
  } catch (error) {
    const message = String((error as Error)?.message || "Webhook processing failed").slice(0, 500);
    if (claimToken) {
      await db.rpc("pooldocai_release_stripe_webhook_event", {
        p_event_id: eventId,
        p_claim_token: claimToken,
        p_error: message
      });
    }
    console.error("Stripe webhook processing failed", { eventId, type: eventType, message });
    return json({ error: "Verified webhook could not be applied; Stripe may retry safely.", code: "STRIPE_WEBHOOK_APPLY_FAILED" }, 500);
  }
});

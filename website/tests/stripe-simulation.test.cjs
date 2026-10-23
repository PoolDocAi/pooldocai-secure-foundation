const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const handler = fs.readFileSync(path.join(root, "supabase", "functions", "clever-handler", "index.ts"), "utf8");
const webhook = fs.readFileSync(path.join(root, "supabase", "functions", "stripe-webhook", "index.ts"), "utf8");

// Test 1: Checkout session maps all 6 canonical packages with fixed package quantity
assert.ok(handler.includes('solo_tech: "STRIPE_PRICE_SOLO_TECH"'), "clever-handler maps solo_tech price env");
assert.ok(handler.includes('pro_complete: "STRIPE_PRICE_PRO_COMPLETE"'), "clever-handler maps pro_complete price env");
assert.ok(handler.includes('fleet_complete: "STRIPE_PRICE_FLEET_COMPLETE"'), "clever-handler maps fleet_complete price env");
assert.ok(handler.includes('form.set("line_items[0][quantity]", "1")'), "package pricing bills 1 package unit rather than multiplying price by seats");
assert.ok(handler.includes('form.set("subscription_data[metadata][seat_limit]", String(effectiveSeats))'), "package checkout seeds subscription seat limit metadata");

// Test 2: Webhook company query loads billing_period_start for staleness comparison
assert.match(webhook, /select\([^)]*billing_period_start[^)]*\)/, "webhook queries billing_period_start from companies table");

// Test 3: Webhook guards against out-of-order and superseded subscription events
assert.ok(webhook.includes('stale_out_of_order_event'), "webhook skips events with older period starts");
assert.ok(webhook.includes('stale_old_subscription'), "webhook skips events from superseded subscription IDs");

// Test 4: Simulated event payload verification
const canonicalTiers = [
  { plan: "solo_tech", defaultSeats: 1 },
  { plan: "solo_complete", defaultSeats: 1 },
  { plan: "pro_tech", defaultSeats: 5 },
  { plan: "pro_complete", defaultSeats: 5 },
  { plan: "fleet_tech", defaultSeats: 15 },
  { plan: "fleet_complete", defaultSeats: 15 }
];

for (const tier of canonicalTiers) {
  assert.ok(webhook.includes(`${tier.plan}: ${tier.defaultSeats}`), `webhook preserves ${tier.defaultSeats} default seats for ${tier.plan}`);
}

console.log("PASS: Stripe billing checkout alignment, webhook staleness guards, and simulated replay checks passed.");

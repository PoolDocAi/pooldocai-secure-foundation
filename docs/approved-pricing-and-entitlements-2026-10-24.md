# PoolDocAI — Approved Pricing & Entitlements Specification
**Owner approval:** 2026-10-24
**Status:** Approved for implementation and testing on PR #14 only; **NOT APPROVED FOR PRODUCTION BILLING/DEPLOYMENT**.
**Prior proposal status:** Supersedes the $79 minimum and all $29/$39/$75 conflicting draft proposals except the final exact tables below. No founders discount now. Existing legacy subscription rights must remain intact.
**Owner-approved margin policy:** Subscription prices are not automatically reduced as internal diagnostic costs fall. More approved knowledge and less paid web research should raise PoolDocAI's gross/contribution margins, not trigger automatic plan discounts, additional free seats, additional free sessions, or automatic allowance increases. Any future pricing changes require a separate owner commercial decision. Continue maintaining safety, evidence quality, and consent while optimizing retrieval and model routing.

## A. Recurring subscriptions (USD, monthly)
All figures are **company-wide pooled diagnostic cases per billing period**, NOT per-seat quotas, NOT separate homeowner/technician buckets, and NOT a number of AI messages. A new diagnostic case counts once for its verified company; follow-ups in that same case do not open extra sessions. Every case still requires cost and turn/timeout protection. The public demo's 8 turns/mode are separate.

| Track | Plan | Base price/month | Included named active seats | Monthly pooled diagnostic sessions | Homeowner/widget |
|---|---|---:|---:|---:|---|
| Tech-Only | Solo | $39 | 1 | 50 | No |
| Tech-Only | Route | $75 | 2 | 150 | No |
| Tech-Only | Pro Team | $149 | 6 | 400 | No |
| Tech-Only | Fleet | $269 | 15 | 800 | No |
| Complete | Solo | $59 | 1 | 80 | Yes, when feature becomes actually available |
| Complete | Route | $109 | 2 | 200 | Yes, when available |
| Complete | Pro Team | $199 | 6 | 500 | Yes, when available |
| Complete | Fleet | $369 | 15 | 1000 | Yes, when available |
| Both | Enterprise | Written custom quote | Contracted | Contracted company pool | Contracted |

### Seats
- A seat is one **named active account** within the company. For Solo, the owner/operator account must be able to perform both company administration and technician diagnosis within **one** seat. Resolve how company-admin, technician, and read-only member roles consume paid seats before implementing; current live seat enforcement counts active members, not only technicians. No promise of a free admin login without a separately approved entitlement.
- Extras: **+$19 per added active seat per month**, only on Route, Pro Team or Fleet; not on Solo. Maximum **additional** seats: Route +2 (total 4), Pro Team +4 (total 10), Fleet +5 (total 20); beyond Fleet to an Enterprise quote/upgrade. The maximum is not a seat purchase quantity default. Extra seats do not create or reset diagnostic-session allowances.
- Show the customer the incremental amount, total monthly recurring charge, total seats, pooled sessions, renewal/cancellation/proration rules. If the next tier is better value, recommend it and let the customer choose an eligible plan.
- Never create additional seats through client-supplied `seatQuantity` or subscription metadata alone. Server computes allowed and **paid** extra seat quantity; Stripe line items, subscription changes and verified webhook entitlements must agree. Restrict concurrent updates and replay/refund/downgrade handling.

### One-time, same-company, same-current-billing-period session packs
| Pack | Price, one time | Units credited to monthly pool |
|---|---:|---:|
| Mini | $19 | +25 |
| Plus | $59 | +100 |
| Max | $129 | +250 |

- No rollover, carryover, renewal or auto-overage. Packs expire at actual billing period end. Refund/reversal requires idempotent ledger reversal and fail-closed counter adjustment; never mischarge for unspent credits or revive spent credits. Expose visible remaining balance, available packs, month/period end and usage history.
- Store packs in an append-only verified-purchase ledger keyed by provider event/payment identity, tenant/company ID, period start/end and package type. Grant only on independently verified, paid Stripe event; do not accept frontend proof or free-form quantity. Handle duplicate/out-of-order webhook, proration/rebilling, multi-purchase and refund.
- Prevent packs from crossing company boundaries. Require purchases to have current active company billing access. Count against the same `pooldocai_company_monthly_sessions` quota/RPC in an atomic transaction. Run downgrade/plan-change math with preservation of already-billed entitlements and no silent loss mid-period.
- UI should display an upgrade suggestion when upgrading yields more sessions/seats for equal or less total price. Example: Tech Pro +250 top-up = $278 / 650 cases, worse than Fleet $269 / 800; recommend Fleet. Do not imply that top-ups or online billing are currently enabled until tests actually pass.

### Pricing arbitrage
For the same track, **one higher tier** is cheaper or no more expensive and has at least as much combined capacity as **two immediate lower-tier subscriptions**:
- Tech 2 Solo $78/2/100 vs Route $75/2/150; 2 Route $150/4/300 vs Pro $149/6/400; 2 Pro $298/12/800 vs Fleet $269/15/800.
- Complete 2 Solo $118/2/160 vs Route $109/2/200; 2 Route $218/4/400 vs Pro $199/6/500; 2 Pro $398/12/1000 vs Fleet $369/15/1000.
- One primary active subscription per company, plus verified paid addons/topups. Identity/linking safeguards should minimize duplicate company registrations without accidentally merging legitimate separately owned pool companies. Never merge company data automatically.

## B. Canonical product language
**Core:** "Every plan includes one company-wide pool of diagnostic sessions per month. Sessions are shared across authorized seats, not allocated per technician. On Complete plans, eligible homeowner conversations and technician troubleshooting draw from that same monthly pool."
**Tech-Only:** "Includes [N] pooled diagnostic sessions each month, shared by all [X] included technician accounts. Homeowner website chat is not included."
**Complete:** "Includes [N] pooled diagnostic sessions monthly, shared across your technician accounts and eligible homeowner conversations. There are no separate homeowner and technician quotas."
**Add seat:** "Add one technician account to your existing company plan for $19/month. Your pooled diagnostic-session allowance stays the same."
**Top-up:** "Add [N] diagnostic sessions to your company's current billing-period pool for [$]. Unused sessions expire when that period ends. This is a one-time purchase with no automatic overage charges."
**Pilot/demonstration:** Describe planned checkout, technician notes, homeowner widget and photo functionality according to true production availability. Public demo 8-turn cap is unrelated to paid session pool.
- Remove contradicting copy ("customer chats never use up technician sessions"; separate homeowner/tech quotas; 2,000+ Homeowner + 3,500+ Field Tech sessions; grandfathered $49 public new-customer offer). Update hero, pricing cards, ROI, forms, FAQ, onboarding/portal, help, SEO snippets and copies in `PoolDocAI_Release_Bundle/website/` together. Prefer single machine-readable plan catalog and one shared copy generation source; avoid risky unrelated whole-app rewrite.

## C. Required pre-billing code work and verified release gates
1. **P0 checkout/entitlement integrity:** Existing `clever-handler` reads `seatQuantity` (up to 500), charges one package `line_items[0][quantity]=1`, forwards seat_limit through Stripe metadata. Webhook reads that metadata, yet live DB trigger hardcodes base seats. Fix server-side purchase authorization and paid quantities end-to-end. Canonicalize historical plan IDs (`solo_tech`/ `solo_tech_only`; `pro_tech`/ `pro_team_tech_only`, etc.), migrate forward only, preserve legacy rights. Never derive billable entitlements from mutable metadata as sole proof.
2. Implement versioned plan catalog validated both at checkout and webhook. Include exact price IDs from authorized test/live Stripe environment, immutable plan version, included seats, pool, allowed add-ons, maxima. Reject unknown prices/legacy SKUs for new purchase; preserve existing subscribers and historical audits.
3. Stripe sandbox event tests for initial checkout, recurring renewal, multiple add-on seats, top-up same period, refund, dunning, cancellation, downgrade, duplicate and out-of-order webhooks, charge failure, two concurrent checkouts, cross-company spoofing and legacy preservation. No production Stripe key, product creation or live charges without owner release authorization.
4. Atomic reservation/credit to avoid overconsumption and overspending, per-tenant AI token/search cost measurement reconciled to provider invoices, budget guards and upper cost exposure limits. No "guaranteed profitable" claims until validated fully utilized worst-case cost + provider search pricing + infra/support/storage + fees, with a safety margin. Do not weaken safety/grounding or falsely promote unsourced answers to control cost.
5. **Learning economics:** Save confirmed case outcomes to company private records; make global lessons searchable only with company + case-level rights, privacy minimization and platform owner review. Live DB audit (2026-10-24) found 0 approved shared lessons, 1 pending item, 0 company manual chunks and no `search_kb_entries` or `pooldocai_approve_learning_case` functions, while PR code refers to them. Verify migrations and deployed Edge Functions before claiming a working learning-feedback cost reduction. Make approved reliable KB-first matching capable of skipping paid web grounding when evidence is sufficient, with source/version/equipment matching; cheaper low-complexity synthesis/templates for approved repeat cases; ground in web when KB is missing or stale; audit retrieval hit rate, grounded search rate, model token spend and actual cost/case by cohort. Consent revocation removes shared knowledge promptly. No tenant SOP leakage.
6. The UI-only Vercel preview is not an integrated staging backend. Do not claim checkout, seat and purchase flows are E2E tested in that preview. Recommend isolated staging with synthetic users but do not provision paid infrastructure without approval.
7. Maintain exact `website/` to `PoolDocAI_Release_Bundle/website/` parity, run all existing tests and new pricing/learning tests, full CI, source reviews, preview at exact SHA; browser tests when available. No merge to main, production deploy, live DB writes, Stripe activation, secrets or paid resources until explicit later release approval.

## D. Implementation ownership / sequence
This document records **approved product/commercial intent**, not successful live activation. AntiGravity executes on the existing open PR after checking Issue #15 for prior TASK-004 work and getting ACK. ChatGPT independently reviews each bounded slice. Work in safe order: (1) catalog + copy/marketing, (2) backend entitlement migration & addons, (3) payment verification tests + cost bounds, (4) isolated staging E2E, (5) later owner-approved production release. Avoid overlapping edits to the shared branch.

# PoolDocAI topic queue -> complete article -> editorial review

## Current status

Owner request 2026-10-29: eight topics, including **Weekly care of your pool**. This is implementation work on draft PR #27, NOT a deployed feature. The list is stored in Staging-only SQL candidate security/staging-topic-queue-candidate.sql. No queue, provider credentials, article or publication is changed in the live databases by committing this code.

## Owner experience after authorized Staging activation

In private Resources Studio, select **Article topics** from the sidebar. Use **Add topic** to queue an idea and optional editorial notes. Select the saved topic and click **Create article**. A private backend generates a full grounded article, validates it against the complete-draft schema, creates an ordinary private CMS draft using the reserved article UUID and standard immutable revision workflow, links the topic to the draft, and opens the full article editor. A topic already drafted opens its existing draft; no duplicate article is generated. No approvals, publication, holds, media rights or diagnostic-knowledge entries are generated.

## Activation gates — separate owner authorization required

1. Independently audit the SQL candidate in an isolated database; generate an approved Staging migration with the installed Supabase CLI, respecting actual migration history and the existing resources_cms_command_owner privileges. Do not apply the candidate directly to Production or skip tested PostgreSQL 17 compatibility.
2. After applying a reviewed migration to Staging only, verify the owner-only RPC permission, no direct anon/auth table access, eight seeded topics, and no alteration to the original 31 held articles.
3. Configure CMS_TOPIC_QUEUE_ENABLED=1 for **protected Staging** only and CMS_GEMINI_API_KEY as a server-only secret. Key must never go to GitHub, a browser bundle or chat. The feature remains inactive unless the flag is enabled; the button remains disabled without a server-side key.
4. Audit provider usage limits and billing before enabling: a successful click makes **two Gemini 2.5 Flash generateContent calls** (Google Search grounding, then structured JSON article). Each topic permits at most three claimed attempts, and each queue is capped at 100 active topics. This is **NOT** a global durable dollar budget; do not activate a paid model until spending thresholds, concurrency and request-timeout behavior are separately approved/verified.
5. Owner tests one queued synthetic topic in the SSO-protected Vercel Preview on Staging Supabase. Verify data/auth isolation, real response time, 390px/desktop UI, token/error handling, source links, HTML sanitization, editorial flags, and standard private revisions. The model's search grounding metadata is a *provenance indicator*, not independent source/claim verification. The owner verifies every important fact and the original primary source before editorial approval.
6. Vercel automatic preview deployments for high-volume branches remain suppressed. Do not bypass the team-wide Hobby quota to make an unreviewed deploy. No public CMS exposure, no Production migration, no publication without separately approved exact revision/checksum.

## Initial eight editorial topics

1. Ruthenium in salt chlorine generator cells
2. Maintenance of a salt chlorine generator system
3. Sodium bisulfate versus muriatic acid for pools
4. Borates in pools: borax, boric acid and sodium tetraborate
5. Salt chlorine generators versus tablets, UV and AOP
6. Types of algae in swimming pools
7. Metals in pools: stains, testing and treatments
8. Weekly care of your pool

Weekly care needs to separate routine tasks from more frequent testing, based on CDC residential guidance (chlorine and pH at least twice per day, with additional tests when warranted). Include manual cleaning, baskets, filter pressure, circulation, equipment checks and water balance. Discuss optional conveniences such as automation, cleaners, borates and algaecides without claiming they replace sanitizer or must be dosed routinely. https://www.cdc.gov/healthy-swimming/about/home-pool-and-hot-tub-water-treatment-and-testing.html

Reference requirement: https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/37
Provider docs: https://ai.google.dev/gemini-api/docs/google-search

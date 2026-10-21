# PoolDocAI document worker

Node 20+ service that downloads a company-private upload from Supabase Storage, extracts text/OCR, chunks it, writes private tenant-scoped chunks, and queues eligible opted-in content for human learning review.

See the repository-root `README_DOCUMENT_PIPELINE.md` for environment variables, deployment, SQL migration, privacy behavior and test steps.

Local check:

```sh
npm install
cp .env.example .env
# Fill secrets in your local shell/environment (never commit .env)
npm run check
npm start
```

`GET /health` is public and returns health only. `POST /process` requires the `x-pooldocai-worker-secret` header. The service-role key must remain server-side.

# rubico-lead-engine-api

Backend for the Rubico Lead Engine. Owns **all business logic**: ingestion,
canonical domain resolution, dedupe, suppression, fit filtering, signal decay,
scoring, LLM classification and brief generation, cost metering, and job
execution.

It does **not** own scheduling (n8n), Slack formatting (n8n), or UI (Next.js).
See `requirement.md` for the specification and `implementation.md` for the
phase-by-phase build log.

## Quick start

```bash
npm install
cp .env.example .env          # then fill it in — boot fails fast on anything missing
npm run db:migrate            # apply migrations
npm run db:seed               # scoring_config defaults
npm run start:dev
```

Requires PostgreSQL 16 and Node 24.

## Scripts

| Script | Does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm test` | Unit + integration tests (needs a reachable database) |
| `npm run lint` | oxlint |
| `npm run db:migrate` / `db:seed` / `db:reset` | Prisma migrate, seed, reset **+ seed** |
| `npm run openapi:export` | Build, then write `openapi.json` at the repo root |
| `npm run auth:hash -- '<password>'` | argon2id hash for `DASHBOARD_PASSWORD_HASH` |

## HTTP surface

Three namespaces, three auth models (§8):

| Namespace | Auth | Client |
|---|---|---|
| `/internal/*` | `X-Internal-Token` | n8n |
| `/api/*` | `Authorization: Bearer <session token>` | The Next.js **server** layer only |
| `/openapi.json` | none, non-production only | Type generation |

**CORS is disabled entirely** and the server binds to `127.0.0.1` by default.
The browser never calls this API directly (FR-B14, FR-B15).

## The OpenAPI contract, and the thing it cannot enforce

`/api/*` DTOs are declared once as Zod schemas; the OpenAPI document is
generated from them, so validation and contract cannot drift (§9). The
frontend generates its types from `openapi.json` — no hand-written duplicates,
no published package.

> **FR-B19 — read this before changing an `/api/*` DTO.**
>
> A breaking change to any `/api/*` DTO requires a matching PR in
> **`rubico-lead-engine-web`**. Note it in the PR description.
>
> There is **no build-time enforcement across the two repos**, and pretending
> otherwise is worse than acknowledging it. Nothing here will fail if you skip
> the companion PR — the frontend simply breaks at runtime after its next type
> generation. Re-run `npm run openapi:export` and commit the result in the
> same PR as the DTO change.

## Jobs

n8n triggers these over HTTP; the backend never schedules anything itself, and
`@nestjs/schedule` is deliberately not installed so a second scheduler cannot
appear by accident.

| Job | Typical trigger |
|---|---|
| `ingest.sec-edgar` | 2× daily |
| `ingest.ats` | 1× daily |
| `ingest.hackernews` | 1× daily |
| `ingest.product-hunt` | 1× daily |
| `pipeline.run` | 2× daily, after ingestion |
| `score.rescore-all` | nightly |
| `maintenance.reverify-legacy` | weekly |

```bash
curl -X POST http://127.0.0.1:3000/internal/jobs/ingest.sec-edgar/run \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN" \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{}'
```

Returns `202` immediately with a `jobRunId`; poll
`GET /internal/jobs/runs/:jobRunId` for status and counts.

## Cost control

Every billable call goes through `MeteredClient`, the one thing standing
between this project and a surprise bill. It enforces a per-provider monthly
cap, a per-lead pre-approval budget and a daily guard, and writes an
`api_usage` row for every call. A cap breach **halts the pipeline and alerts**;
it does not degrade quietly.

The test that proves it — `src/common/metering/metered-client.spec.ts`, the
§6.3 acceptance test — is the reason this stays inside $25/month. Not
discipline; that test.

## Known gaps

Tracked with detail in `implementation.md`:

- **A1 is not met.** `sec-edgar` produces no companies under the default
  domain resolver, because SEC publishes no website for a Form D filer, and
  `ingest.ats` only visits companies already marked as tracked.
- **No live LLM call has been made.** `GEMINI_API_KEY` and `ANTHROPIC_API_KEY`
  are placeholders, so A6 is unverified against a real model.
- `ingest.product-hunt` is untested live — `PRODUCT_HUNT_TOKEN` is a
  placeholder.
- A run interrupted by a process restart stays `running` in `job_runs`.
  Postgres frees the advisory lock so nothing deadlocks, but the row needs a
  sweeper.

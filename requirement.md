# Rubico Lead Engine — Backend Requirements (NestJS)

**Repo:** `rubico-lead-engine-api`
**Scope:** Phase 0 only. Free sources, $25/month ceiling.
**Companions:** `rubico-lead-engine-web` (Next.js), `rubico-lead-engine-n8n` (workflow definitions)
**Parent spec:** Requirements Specification v1.0

---

## 1. Responsibility boundary

The backend owns **all business logic**. It is the only component that knows how to normalise, filter, enrich, score, classify, or spend money.

| Owns | Does not own |
|---|---|
| Ingestion adapters and parsing | Scheduling (n8n triggers) |
| Canonical domain resolution, dedupe, suppression | Slack message formatting (n8n) |
| Fit filter, signal detection, decay, compound detection | UI rendering (Next.js) |
| Scoring arithmetic | Session UI state (Next.js) |
| LLM classification and brief generation | Cron definitions |
| Cost metering and cap enforcement | |
| Job execution and idempotency | |

**Design consequence:** because job triggering is nothing but an authenticated HTTP endpoint, n8n is replaceable by `cron` + `curl` at any time without touching application code. That is deliberate — the backend must never assume n8n exists.

---

## 2. Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | NestJS (TypeScript, strict mode) | Express adapter is fine; Fastify is unnecessary at this scale |
| Database | PostgreSQL 16 | JSONB for raw payloads |
| ORM | Prisma | Migrations are the reason. Bulk rescore uses raw SQL |
| Validation | Zod | Also used for LLM structured output schemas |
| API contract | `@nestjs/swagger` → OpenAPI 3 | The frontend generates its types from this. See §9 |
| Scheduling | none in Phase 0 | n8n triggers. `@nestjs/schedule` stays uninstalled so no accidental second scheduler |
| Queue | none in Phase 0 | Postgres `job_runs` + advisory locks. See §7 |
| HTTP client | native `fetch` | Wrapped by `MeteredClient` for billable calls |

### 2.1 Deliberately absent

Redis, BullMQ, Docker in production, microservices, an auth provider, a job dashboard. Each has a named trigger condition in the parent spec; none is met at Phase 0 volume (~1,000 records/day).

---

## 3. Module layout

```
src/
├── common/
│   ├── config/                  # typed env schema, fail-fast on boot
│   ├── metering/                # BUILD FIRST — see §6
│   ├── auth/                    # internal-token guard, session guard
│   └── idempotency/             # idempotency-key interceptor
├── jobs/                        # job registry + runner + advisory locks
├── sources/
│   ├── signal-source.interface.ts
│   ├── sec-edgar/
│   ├── ats/                     # greenhouse, lever, ashby
│   ├── hackernews/
│   ├── product-hunt/
│   └── first-party/
├── companies/                   # canonical domain, dedupe, suppression, fit filter
├── enrichment/
│   ├── enricher.interface.ts
│   ├── homepage-fingerprint/    # modern + legacy stack detection
│   ├── dns/
│   └── github/
├── signals/                     # dedupe hash, decay, compound detection
├── scoring/                     # pure functions + rescore job
├── llm/
│   ├── llm-provider.interface.ts
│   ├── gemini/
│   ├── anthropic/
│   ├── classify/
│   └── brief/
├── leads/                       # lifecycle, decisions
├── contacts/                    # ContactResolver iface; manual impl only in P0
├── outreach/                    # INTERFACE ONLY — no implementations in P0
├── digest/                      # daily digest assembly (pull endpoint)
├── notifications/               # Notifier iface → n8n webhook
└── metrics/                     # funnel + spend
```

Module boundaries map 1:1 onto the pipeline steps in parent spec §4.1.

---

## 4. The eight seams

Declared as interfaces on Day 0, before any implementation. Each is where a Phase 1–3 upgrade lands as a new provider class plus one config line.

```ts
// sources/signal-source.interface.ts
export interface SignalSource {
  readonly name: string;                       // 'sec-edgar'
  readonly signalTypes: SignalType[];          // ['S1']
  fetch(since: Date): Promise<RawSignal[]>;
}

// enrichment/enricher.interface.ts
export interface Enricher {
  readonly name: string;
  readonly cost: 'free' | 'metered';
  enrich(company: Company): Promise<EnrichmentResult>;
}

// llm/llm-provider.interface.ts
export interface LlmProvider {
  readonly name: string;                       // 'gemini' | 'anthropic'
  complete<T>(args: {
    system: string;
    user: string;
    schema: ZodSchema<T>;
    model: string;
    batch?: boolean;
    cacheSystem?: boolean;
  }): Promise<{ result: T; usage: TokenUsage }>;
}

// contacts/contact-resolver.interface.ts
export interface ContactResolver {
  readonly name: string;
  readonly cost: 'free' | 'metered';
  resolve(company: Company, role: string[]): Promise<ResolvedContact[]>;
}

// notifications/notifier.interface.ts
export interface Notifier {
  send(event: NotificationEvent): Promise<void>;
}

// outreach/outreach-sender.interface.ts  ← Phase 1 fills this. Zero impls in P0.
export interface OutreachSender {
  send(lead: Lead, contact: Contact, body: string): Promise<SendResult>;
}
```

Plus two non-code seams: the `MeteredClient` wrapper (§6) and the `scoring_config` table (§5).

**FR-B1** Every provider is registered through a Nest module token, resolved by name from config. Adding a provider must never require editing a call site.

**FR-B2** No module may make a billable outbound call except through `MeteredClient`. Enforced by code review and by the fact that provider constructors receive `MeteredClient` rather than raw `fetch`.

---

## 5. Data model

Seven tables. The six from parent spec §10.1 plus `job_runs`.

```prisma
model Company {
  id                String   @id @default(cuid())
  canonicalDomain   String   @unique
  name              String
  country           String?
  region            String?
  headcountBand     String?
  industry          String?
  detectedStack     Json?
  legacyFlags       Json?
  atsProvider       String?
  atsSlug           String?
  firstSeenAt       DateTime @default(now())
  lastEnrichedAt    DateTime?
  suppressionReason String?   // client | competitor | rejected | do-not-contact
  signals           Signal[]
  leads             Lead[]
  contacts          Contact[]
  @@index([suppressionReason])
}

model Signal {
  id             String   @id @default(cuid())
  companyId      String
  type           String   // F-LEG | S1..S5
  eventDate      DateTime
  observedAt     DateTime @default(now())
  sourceUrl      String
  sourceName     String
  excerpt        String?
  raw            Json
  confirmedByLlm Boolean  @default(false)
  dedupeHash     String   @unique
  company        Company  @relation(fields: [companyId], references: [id])
  @@index([companyId, type, eventDate])
}

model Lead {
  id                String   @id @default(cuid())
  companyId         String
  fitScore          Int
  intentScore       Float
  compoundBonus     Int      @default(0)
  totalScore        Int
  band              String   // immediate | high | investigate | ignore
  llmClassification Json?
  likelyNeed        String?
  rubicoService     String?
  brief             Json?
  confidence        String?
  status            String   @default("new")
  scoredAt          DateTime
  createdAt         DateTime @default(now())
  company           Company  @relation(fields: [companyId], references: [id])
  decisions         Decision[]
  @@index([band, status, totalScore])
}

model Contact {
  id         String   @id @default(cuid())
  companyId  String
  name       String
  role       String?
  seniority  String?
  email      String?
  emailStatus String?
  source     String
  resolvedAt DateTime @default(now())
  creditCost Float    @default(0)
  company    Company  @relation(fields: [companyId], references: [id])
}

model Decision {
  id         String   @id @default(cuid())
  leadId     String
  user       String
  decision   String   // approved | rejected
  reasonCode String   // wrong_fit | stale | already_known | no_real_need | bad_contact | good
  notes      String?
  scoreAtDecision Int
  decidedAt  DateTime @default(now())
  lead       Lead     @relation(fields: [leadId], references: [id])
}

model ApiUsage {
  id        String   @id @default(cuid())
  date      DateTime @default(now())
  provider  String
  operation String
  units     Float
  usdCost   Float
  leadId    String?
  @@index([date, provider])
}

model ScoringConfig {
  key       String   @id   // 'S1.weight' | 'S1.halfLifeDays' | 'compound.bonus'
  value     Float
  updatedAt DateTime @updatedAt
  updatedBy String?
}

model JobRun {
  id             String   @id @default(cuid())
  jobName        String
  idempotencyKey String   @unique
  status         String   // queued | running | succeeded | failed | skipped
  params         Json?
  counts         Json?
  error          String?
  triggeredBy    String   // 'n8n' | 'manual'
  startedAt      DateTime?
  finishedAt     DateTime?
  createdAt      DateTime @default(now())
  @@index([jobName, createdAt])
}
```

**FR-B3** `Decision.scoreAtDecision` is captured at decision time, not read from `Lead.totalScore` later — the lead's score changes nightly and calibration (metric M6) requires the score the human actually saw.

**FR-B4** All six pipeline tables plus `job_runs` and `api_usage` exist in the first migration. Retrofitting `api_usage` means retrofitting every call site.

---

## 6. Metering and cost enforcement — build first

**This ships before the first LLM call, not after.**

### 6.1 `MeteredClient`

Wraps every billable outbound call. Single choke point for parent spec FR-C1 through FR-C4.

```ts
await meteredClient.call({
  provider: 'gemini',
  operation: 'classify',
  leadId,
  estimatedCost: 0.0002,
  execute: () => provider.complete({...}),
  computeCost: (usage) => priceTable.compute('gemini', model, usage),
});
```

Behaviour, in order:
1. Reject if month-to-date spend for `provider` ≥ its configured hard cap (FR-C2)
2. Reject if `leadId` has already consumed ≥ `PER_LEAD_BUDGET_USD` (default `0.10`) pre-approval (FR-C4)
3. If MTD spend ≥ 80% of the daily budget, reject unless the lead's band is `immediate` or `high` (FR-C3)
4. Execute
5. Write `ApiUsage` with actual computed cost
6. On rejection at step 1, fire a `cost.cap_breached` notification (§8.2) and mark the job run `failed`

### 6.2 Requirements

- **FR-C1** Every metered call writes `ApiUsage`. No exceptions.
- **FR-C2** Hard cap per provider. Breach **halts the pipeline and alerts**. It does not degrade quietly.
- **FR-C5** Contact resolution rejects unless `lead.status === 'approved'`. Enforced by a Nest guard on the route *and* an assertion inside the service, because the service will later be called from a job as well as a route.
- **FR-C9** Price table lives in config, not code. Rates move.

### 6.3 Acceptance test — do this before writing any LLM code

Set `GEMINI_MONTHLY_CAP_USD=0.01`, run the pipeline, and verify:
1. The pipeline halts
2. A `cost.cap_breached` payload reaches the n8n alert webhook
3. `job_runs.status = 'failed'` with a readable error
4. No further metered calls execute until the cap is raised

This test is the reason the project stays inside $25/month. Not discipline — this test.

---

## 7. Job execution

n8n triggers jobs over HTTP. The backend runs them asynchronously and reports status by polling.

### 7.1 Runner contract

- **FR-B5** `POST /internal/jobs/:jobName/run` returns **202 Accepted immediately** with a `jobRunId`. It never blocks on the work. n8n HTTP nodes time out; ingestion can exceed that.
- **FR-B6** Concurrency is prevented by a Postgres advisory lock keyed on `jobName` (`pg_try_advisory_lock`). A second trigger for a running job returns 202 with `status: 'skipped'` and the in-flight run's id.
- **FR-B7** Idempotency: the `X-Idempotency-Key` header is required. If the key already exists in `job_runs`, return the existing run rather than starting a new one. n8n retries on failure, and re-ingesting must not duplicate or re-spend.
- **FR-B8** Every run writes `counts` — records fetched, deduped, filtered out, enriched, classified, scored, briefed. These counts are the source for metrics M1–M8.
- **FR-B9** A run that fails partway leaves already-committed work intact. Ingestion is per-record transactional, not per-batch.

### 7.2 Registered jobs (Phase 0)

| Job name | Does | Typical trigger |
|---|---|---|
| `ingest.sec-edgar` | Form D filings since watermark | 2× daily |
| `ingest.ats` | Greenhouse/Lever/Ashby boards for tracked companies | 1× daily |
| `ingest.hackernews` | HN Algolia search for pain signals | 1× daily |
| `ingest.product-hunt` | Recent launches | 1× daily |
| `pipeline.run` | enrich → classify → score → brief, for all pending | 2× daily, after ingestion |
| `score.rescore-all` | Recompute decay for every active lead | nightly |
| `maintenance.reverify-legacy` | Re-check `F-LEG` flags (FR-S5) | weekly |

**FR-B10** `pipeline.run` is a single job rather than four chained ones. Fewer moving parts in n8n, and the stage boundaries are already visible in `counts`.

**FR-B11** `score.rescore-all` uses a single raw SQL `UPDATE ... FROM` statement, not per-row Prisma writes. It must complete in under 30 minutes (NFR-4) and will be handling thousands of rows.

---

## 8. HTTP surface

Three namespaces with three different auth models.

### 8.1 `/internal/*` — n8n → backend

Auth: `X-Internal-Token` header matching `INTERNAL_API_TOKEN`. Constant-time comparison. See the n8n doc for the credential setup.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `POST` | `/internal/jobs/:jobName/run` | `{ since?: ISO8601, dryRun?: boolean }`; requires `X-Idempotency-Key` | `202 { jobRunId, jobName, status }` |
| `GET` | `/internal/jobs/runs/:jobRunId` | — | `200 { status, startedAt, finishedAt, counts, error }` |
| `GET` | `/internal/digest/daily` | `?date=YYYY-MM-DD` | `200 { date, counts: { immediate, high, investigate }, leads: DigestLead[] }` |
| `POST` | `/internal/ingest/first-party` | `{ domain, pageUrl, occurredAt, formType, email? }`; requires `X-Idempotency-Key` | `202 { accepted: true }` |
| `GET` | `/internal/health` | — | `200 { status, db, mtdSpendUsd }` |

**FR-B12** `GET /internal/digest/daily` is a **pull** endpoint. n8n already owns scheduling, so the scheduled digest is pulled rather than pushed. This removes webhook URLs, retry logic and delivery failure handling from the backend.

### 8.2 Backend → n8n — outbound, event-driven only

The backend pushes only for things that are unscheduled and urgent. Everything scheduled is pulled.

`POST` to `N8N_ALERT_WEBHOOK_URL` with header `X-Webhook-Token: N8N_WEBHOOK_TOKEN`:

```json
{
  "severity": "critical",
  "type": "cost.cap_breached",
  "message": "gemini MTD spend $25.04 exceeded cap $25.00",
  "context": { "provider": "gemini", "mtdUsd": 25.04, "capUsd": 25.00 },
  "occurredAt": "2026-09-10T04:12:00Z"
}
```

| `type` | Fires when |
|---|---|
| `cost.cap_breached` | FR-C2 halt |
| `job.failed` | Any job run ends `failed` |
| `source.unavailable` | A source has failed 3 consecutive runs (NFR-8 visibility) |

**FR-B13** Notification delivery failure must never fail a job. Log and continue; the health endpoint exposes MTD spend as a fallback signal.

### 8.3 `/api/*` — Next.js server → backend

Auth: `Authorization: Bearer <session token>`. The **browser never calls these directly** — Next's server layer is the only client. Consequences:

- **FR-B14** CORS is disabled entirely. No `enableCors()`.
- **FR-B15** In production the server binds to `127.0.0.1` when Next and n8n are co-hosted. If n8n is on a different host, bind to the private interface and add an IP allowlist.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | `{ email, password }` → session token. Single shared credential set in Phase 0 |
| `POST` | `/api/auth/logout` | |
| `GET` | `/api/auth/me` | |
| `GET` | `/api/leads` | `?band=&status=&minScore=&page=&pageSize=` |
| `GET` | `/api/leads/:id` | Full record: brief, per-signal score contributions, evidence with source URLs |
| `POST` | `/api/leads/:id/decision` | `{ decision, reasonCode, notes? }` → writes `Decision`, updates `Lead.status` |
| `GET` | `/api/companies/:id` | Firmographics, stack, legacy flags, signal history |
| `GET` | `/api/contacts?leadId=` | |
| `POST` | `/api/contacts` | Manual contact entry (Phase 0 has no paid resolver) |
| `GET` | `/api/metrics/funnel` | `?from=&to=` → M1–M8 |
| `GET` | `/api/metrics/spend` | MTD total, per provider, cost per qualified opportunity |
| `GET` | `/api/scoring-config` | |
| `PATCH` | `/api/scoring-config` | Weights and half-lives, no deploy (FR-SC3) |

**FR-B16** `GET /api/leads/:id` returns per-signal score contributions with decay already applied — the frontend renders, it does not compute. Scoring arithmetic exists in exactly one place.

---

## 9. OpenAPI contract — how separate repos stay in sync

**FR-B17** `@nestjs/swagger` decorators on every `/api/*` DTO. Spec served at `/openapi.json` in non-production, and written to `openapi.json` at the repo root by `pnpm run openapi:export` in CI on every merge to main.

**FR-B18** The frontend generates its types from that file (see the frontend doc §4). No hand-written duplicate types, no published npm package, no copy-paste.

**FR-B19** A breaking change to any `/api/*` DTO requires a matching PR in the web repo. Note it in the PR description; there is no build-time enforcement across repos and pretending otherwise is worse than acknowledging it.

Zod schemas remain the runtime validators. `@nestjs/swagger` documents the DTOs. Where they would drift, generate the OpenAPI schema from the Zod schema rather than maintaining two definitions.

---

## 10. Configuration

`common/config` validates the whole environment at boot with Zod and **fails fast** on anything missing.

```
DATABASE_URL
NODE_ENV
PORT
BIND_ADDRESS=127.0.0.1

INTERNAL_API_TOKEN
SESSION_SECRET
DASHBOARD_EMAIL
DASHBOARD_PASSWORD_HASH

N8N_ALERT_WEBHOOK_URL
N8N_WEBHOOK_TOKEN

LLM_CLASSIFY_PROVIDER=gemini
LLM_CLASSIFY_MODEL=gemini-2.5-flash-lite
LLM_BRIEF_PROVIDER=anthropic
LLM_BRIEF_MODEL=claude-sonnet-5
LLM_BRIEF_BATCH=true

GEMINI_API_KEY
ANTHROPIC_API_KEY
GITHUB_TOKEN
PRODUCT_HUNT_TOKEN

MONTHLY_CAP_USD=25
DAILY_CAP_USD=1.5
PER_LEAD_BUDGET_USD=0.10

SEC_USER_AGENT="Rubico Lead Engine (mukul@rubico.tech)"
```

**FR-B20** Model and provider selection is config, not code (parent spec FR-AI1). Rates and models in this category move fast enough that a redeploy to switch is unacceptable.

**FR-B21** `SEC_USER_AGENT` is mandatory and must identify Rubico with a contact address. SEC fair-access requires it.

---

## 11. LLM layer specifics

- **FR-AI2** Structured output constrained by Zod schema at both steps. No free-text parsing.
- **FR-AI3** `brief` uses the batch endpoint (50% off). Nothing here is latency-sensitive.
- **FR-AI4** Prompt-cache the shared system prompt — ICP, service catalogue, scoring rubric. Cache reads cost 10% of standard input and this prefix is identical across thousands of calls.
- **FR-AI5** The classify prompt must be able to return `has_rubico_opportunity: false` and `evidence_sufficient: false`, and those outcomes discard the record before scoring. **Acceptance test:** run a deliberately irrelevant company through it and confirm it says no. A classifier that never refuses is not a filter and doubles downstream cost.
- **FR-AI6** Programmatic validation: every claim in a generated brief must carry a `signalId` that exists in the database. A brief with an uncited claim is rejected and logged as a defect, not surfaced to a human. This is enforced in code, not requested in the prompt.
- **FR-AI7** The suggested opening line references only cited evidence.

---

## 12. Testing

Deliberately narrow. Thirty days.

| Test | Why |
|---|---|
| `scoring` unit tests | Pure functions, cheap, and a silent decay bug survives to the Day-30 review and makes the engine look broken. Cover: decay at t=0 equals base weight; decay at one half-life equals half; 180-day funding contributes < 1; FR-SC4 (no event signal under 30 days → band `ignore` regardless of fit); compound bonus caps at +10 |
| `dedupeHash` unit tests | Same round from four outlets produces one hash |
| Fit filter unit tests | Config-driven rules behave as configured |
| `MeteredClient` integration test | §6.3. The cap actually halts |
| Idempotency integration test | Same `X-Idempotency-Key` twice → one run, one set of rows |

No HTTP-layer tests, no e2e, no coverage target.

---

## 13. Phase 0 acceptance

| # | Criterion |
|---|---|
| A1 | Two live sources (`sec-edgar`, `ats`) produce ≥100 companies with dated signals and source URLs |
| A2 | Re-running any ingestion job three times creates zero duplicate rows |
| A3 | Every lead has an explainable score with per-signal contributions |
| A4 | Scores decrease overnight when no new signals arrive |
| A5 | Cap set to $0.01 halts the pipeline and alerts n8n (§6.3) |
| A6 | Classifier returns `false` for a deliberately irrelevant company |
| A7 | No brief contains a claim without a valid `signalId` |
| A8 | `GET /api/metrics/funnel` returns M1–M8 without manual queries |
| A9 | Contact resolution is unreachable for a lead not in `approved` status |
| A10 | `openapi.json` at repo root, current with `main` |

---

## 14. Explicitly out of scope

Outreach sending (interface only), paid contact resolvers, paid enrichment, multi-user auth and roles, CRM integration, more than the six signals in parent spec §5, a job dashboard, Redis or a queue, Docker in production, rate-limit sophistication beyond a 429 backoff.

# Rubico Lead Engine API — Implementation Plan

Derived from `requirement.md` (Phase 0 scope only).

**How to use this document.** Each phase below is sized to be completed in one focused
session. Before starting a phase, read *only* the `requirement.md` sections listed in its
**Spec refs** line — not the whole spec. Every phase ends with a **Done when** block that
is objectively checkable, so you never have to guess whether you can move on.

Do not start phase N+1 until phase N's **Done when** passes. Do not implement anything
listed under `requirement.md` §14 (Explicitly out of scope).

---

## 0. Current state of the repo

| Thing | Status |
|---|---|
| NestJS 12, Express adapter | installed |
| TypeScript strict, ESM (`"type": "module"`, `moduleResolution: nodenext`) | configured |
| `@prisma/client` 7 + `prisma` 7 + `@prisma/adapter-pg` + `pg` | schema, init migration and seed done in P1 |
| `prisma.config.ts` | exists (skills only) |
| vitest (unit + e2e configs), oxlint, prettier | configured |
| `src/` | Nest starter only (`app.module`, `app.controller`, `app.service`) |
| `.env` | has `DATABASE_URL` only |
| `@nestjs/observe` | ~~placeholder keys~~ — removed in P0 |

**Not yet installed** (added per phase, not all at once): `zod`, `@nestjs/config`,
`@nestjs/swagger`, `pg`, `@types/pg`, `argon2` (or `bcrypt`), `nestjs-zod` or a
zod→OpenAPI bridge.

---

## 1. Standing decisions (apply to every phase)

These are settled. Do not relitigate them mid-phase.

1. **ESM import paths carry `.js`.** `import { Foo } from './foo.js'` — even for `.ts`
   sources. This is what `nodenext` requires and the existing starter already does it.
2. **Package manager is npm** (`package-lock.json` present). The spec mentions `pnpm run
   openapi:export`; use `npm run openapi:export` and note the divergence.
3. **Zod is the single source of truth** for validation. DTO classes exist only to carry
   `@nestjs/swagger` decorators, and where they would drift, generate the OpenAPI schema
   from the Zod schema (spec §9).
4. **No `@nestjs/schedule`.** Never install it. All scheduling is n8n's (spec §2).
5. **No `enableCors()`.** Ever (FR-B14).
6. **No billable outbound call outside `MeteredClient`** (FR-B2). Provider constructors
   take `MeteredClient`, never raw `fetch`.
7. **Every module is a real Nest module** with providers registered by injection token and
   resolved by name from config (FR-B1). No `new SomeProvider()` at a call site.
8. **Scoring arithmetic exists in exactly one place** (FR-B16) — `scoring/`, pure
   functions, no DB access inside them.
9. Prisma 7 uses the `prisma-client` generator with an explicit `output` path. Confirm the
   generated import specifier once in P0 and use it consistently thereafter.

---

## 2. Phase map

| # | Phase | Depends on | Spec refs |
|---|---|---|---|
| P0 | Foundation, config, bootstrap hardening ✅ | — | §2, §10 |
| P1 | Data model + first migration ✅ | P0 | §5 |
| P2 | Auth guards + idempotency interceptor ✅ | P0, P1 | §8.1, §8.3 |
| P3 | Notifications (Notifier → n8n) ✅ | P0 | §8.2 |
| P4 | **Metering & cost enforcement** ✅ | P1, P3 | §6 |
| P5 | Job runner + `/internal/jobs/*` + health | P1, P2, P3 | §7, §8.1 |
| P6 | Companies: canonical domain, dedupe, suppression, fit filter | P1 | §3, parent §4.1 |
| P7 | Signals: dedupe hash, persistence, compound detection | P1, P6 | §5, §12 |
| P8a | Source: `sec-edgar` | P5, P6, P7 | §4, §7.2 |
| P8b | Source: `ats` (greenhouse/lever/ashby) | P8a | §4, §7.2 |
| P8c | Sources: `hackernews`, `product-hunt`, `first-party` | P8a | §7.2, §8.1 |
| P9 | Enrichment (homepage fingerprint, dns, github) | P4, P6 | §3, §4 |
| P10 | Scoring engine + `score.rescore-all` | P1, P7 | §5, §7.2, §12 |
| P11 | LLM layer: classify + brief | P4, P10 | §11 |
| P12 | `pipeline.run` orchestration | P9, P10, P11 | §7.2 |
| P13 | `/api/*` surface | P2, P10 | §8.3 |
| P14 | Digest, metrics, OpenAPI export, acceptance sweep | P12, P13 | §8.1, §9, §13 |

Critical-path note: **P4 before any LLM or paid-enrichment code.** Spec §6 is explicit —
metering ships first, and its acceptance test (§6.3) is what keeps the project under
$25/month. P3 comes before P4 only because the cap breach must fire a notification.

---

## P0 — Foundation, config, bootstrap hardening  ✅ COMPLETE

**Goal:** the app boots, refuses to boot on a bad environment, and binds correctly.
**Spec refs:** §2, §10, §8.3 (FR-B14, FR-B15).

### Tasks
- [x] `npm i zod @nestjs/config` — zod 4.6, @nestjs/config 12.
- [x] `@nestjs/observe` **removed** (package uninstalled, `app.module.ts` and
      `main.ts` cleaned). It shipped placeholder credentials, is not in the §2 stack
      table, and unused telemetry is not worth a boot dependency. Re-add deliberately
      with real keys if observability is wanted later.
- [x] `src/common/config/env.schema.ts` — every §10 variable, Zod-validated, all
      §10 defaults applied. `SEC_USER_AGENT` is regex-checked for a contact address
      (FR-B21). Numeric and boolean vars coerce from strings, treating `''` as unset.
- [x] `src/common/config/config.module.ts` — global, validates via
      `ConfigModule.forRoot({ validate })`, throws during module init so boot aborts.
      `AppConfigService` exposes typed grouped getters (`auth`, `n8n`, `classify`,
      `brief`, `caps`).
- [x] `src/common/config/price-table.ts` + `config/pricing.json` — rates in config,
      not code (FR-C9). `PriceTable.compute()` handles fresh input, cached input,
      cache writes, and the batch multiplier; an unpriced model **throws** rather than
      billing at a guessed rate.
- [x] `main.ts` — binds `BIND_ADDRESS`, no `enableCors()`, `enableShutdownHooks()`.
- [x] `.env.example` committed with every §10 key.
- [x] `.env` was already gitignored; filled in with local dev values.

### Additions beyond §10 (deliberate, noted here so P4 does not re-derive them)
- `GEMINI_MONTHLY_CAP_USD` / `ANTHROPIC_MONTHLY_CAP_USD` — optional, defaulting to
  `MONTHLY_CAP_USD`. FR-C2 is a hard cap **per provider** and §6.3's acceptance test
  sets `GEMINI_MONTHLY_CAP_USD` directly, but §10 lists only the global cap.
  `AppConfigService.monthlyCapFor(provider)` resolves the fallback.
- `PRICE_TABLE_PATH` (default `./config/pricing.json`) — needed to satisfy FR-C9.

### Done when
- [x] `npm run build` clean.
- [x] `npm run start` boots and listens on `127.0.0.1:3000`; a request to the LAN
      interface is refused (FR-B15).
- [x] An invalid environment aborts boot and lists **every** problem at once, naming
      each key.
- [x] `grep -rn "process.env" src/ --include=*.ts` returns hits only inside
      `common/config/`.
- [x] `npm run lint` and `npm test` pass.

### Carried into later phases
- `DASHBOARD_PASSWORD_HASH` in `.env` is the literal placeholder
  `REPLACE_WITH_ARGON2_HASH_IN_P2` — P2 installs argon2 and generates a real hash.
- `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `PRODUCT_HUNT_TOKEN` are
  `REPLACE_ME`. Only needed from P8c/P9/P11 onward.
- Gemini rates in `config/pricing.json` are unverified against Google's current
  pricing page — check before P11 goes live. Anthropic rates are current.

---

## P1 — Data model and first migration  ✅ COMPLETE

**Goal:** all eight models exist in one migration. **Spec refs:** §5 (FR-B3, FR-B4).

> **Spec count correction.** §5 opens with "Seven tables… the six from parent spec
> §10.1 plus `job_runs`", but then defines **eight** models. `ScoringConfig` is the
> extra — §4 treats it as a non-code seam, so it was likely counted separately.
> Eight is what the schema implements: Company, Signal, Lead, Contact, Decision,
> ApiUsage, ScoringConfig, JobRun.

### Tasks
- [x] `prisma/schema.prisma` — all eight §5 models, every `@@index` and `@unique`
      preserved verbatim.
- [x] `prisma-client` generator with `output = "../src/generated/prisma"`,
      `moduleFormat = "esm"`, `runtime = "nodejs"`. Output must live under `src/`
      because `tsconfig.build.json` sets `rootDir: ./src`.
- [x] `prisma.config.ts` rewritten — the scaffolded file called a non-existent
      `definePrismaConfig` and passed a `skills` key that is not in `PrismaConfig`,
      so **every** Prisma CLI command was failing before this phase.
- [x] `npx prisma migrate dev --name init` → one migration,
      `prisma/migrations/20260910080029_init/`.
- [x] `src/common/prisma/prisma.service.ts` — extends `PrismaClient`, implements
      `OnModuleInit`/`OnModuleDestroy`, plus `isHealthy()` for P5's health endpoint.
      Global `PrismaModule`, wired into `AppModule`.
- [x] `prisma/seed.ts` — seeds 19 `ScoringConfig` keys. **Existing rows are left
      untouched**: re-seeding must never reset a weight a human tuned via
      `PATCH /api/scoring-config` (FR-SC3).
- [x] npm scripts: `db:generate`, `db:migrate`, `db:migrate:deploy`, `db:seed`,
      `db:reset` (reset **+ seed**), `db:studio`. `postinstall` is now `prisma generate`.

### ⚠ Prisma 7 facts later phases depend on
1. **`url` is banned from `datasource`** in the schema. The connection string lives
   in `prisma.config.ts`, and the runtime client is constructed with a **driver
   adapter**: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
2. **`pg` and `@prisma/adapter-pg` are installed** as a consequence — which means
   **P5's advisory-lock dependency is already satisfied**. Take the dedicated
   `pg.Client` for `pg_try_advisory_lock` from that package.
3. **Prisma 7 does not auto-load `.env`.** `prisma.config.ts` does
   `import 'dotenv/config'` so CLI and app read the same environment.
4. Generated client is imported as `../generated/prisma/client.js` (`.js`
   specifier, `nodenext` resolves it to the `.ts` source). It is gitignored and
   rebuilt by `postinstall`.
5. Seeds run through `tsx` (`tsx prisma/seed.ts`) — Node's native type stripping
   cannot resolve the generated client's `.js` → `.ts` specifiers.
6. `prisma migrate reset` refuses to run unattended; it requires explicit user
   consent via `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`.
7. **`migrate reset` and `migrate dev` no longer auto-run the seed.** Prisma 7
   removed that (and the `--skip-seed` flag with it); seeding is an explicit
   `prisma db seed`. `npm run db:reset` chains both so a reset never silently
   leaves `scoring_config` empty — an empty scoring config would make every
   downstream score zero with no error.

### Seeded scoring config — PROVISIONAL
The authoritative weights live in **parent spec §5, which is not in this repo**.
The 19 seeded values are sane placeholders chosen to satisfy the §12 tests, most
notably `S1.weight = 25` / `S1.halfLifeDays = 30`, which makes a 180-day funding
signal contribute `25 × 0.5^6 = 0.39` (< 1, as §12 requires). Replace them when the
parent spec is to hand. Keys seeded:

- `S1..S5.weight`, `S1..S5.halfLifeDays`, `F-LEG.weight`, `F-LEG.halfLifeDays`
- `compound.bonus` (10, the §12 cap), `compound.windowDays`, `compound.minDistinctTypes`
- `band.immediate.min`, `band.high.min`, `band.investigate.min`
- `scoring.eventSignalFreshnessDays` (30 — FR-SC4)

Fit-filter thresholds are **not** seeded; P6 adds its own keys when the ICP rules
are written.

### Done when
- [x] All eight tables plus every §5 index exist in `public` — verified by querying
      `pg_tables` / `pg_indexes`. `Signal_dedupeHash_key` is a **unique** index
      (that uniqueness is the A2 dedupe mechanism).
- [x] `PrismaService` resolves through Nest DI; `SELECT 1` and `isHealthy()` succeed.
- [x] `npm run db:seed` twice → 19 created, then 0 created / 19 untouched.
- [x] `npm run build`, `npm run lint`, `npm test` all pass.
- [x] `npx prisma migrate reset` from empty (run manually by the user) →
      migration re-applied, 9 tables, 8 non-pkey indexes, then `db:seed` →
      19 rows. Seeded `S1` values satisfy the §12 constraint: a 180-day funding
      signal contributes **0.391** (< 1).

---

## P2 — Auth guards and idempotency  ✅ COMPLETE

**Goal:** three auth models exist as guards before any route needs them.
**Spec refs:** §8.1, §8.3, §7.1 (FR-B7).

### Tasks
- [x] `common/auth/safe-compare.ts` — constant-time comparison. Both inputs are
      SHA-256 digested before `timingSafeEqual`, so the comparison is constant-time
      **and** length-independent. An early `a.length !== b.length` return would be
      simpler but leaks the secret's length through timing.
- [x] `common/auth/internal-token.guard.ts` — `X-Internal-Token` vs
      `INTERNAL_API_TOKEN` (§8.1).
- [x] `common/auth/session.service.ts` — argon2id via `@node-rs/argon2`
      (prebuilt binaries; the native `argon2` package needs an install script,
      which this npm blocks). Stateless HMAC-SHA256 token: `v1.<payload>.<sig>`,
      12-hour TTL, keyed on `SESSION_SECRET`.
- [x] `common/auth/session.guard.ts` — `Authorization: Bearer <token>`, attaches
      `request.sessionClaims`.
- [x] `common/idempotency/idempotency.interceptor.ts` — requires and validates
      `X-Idempotency-Key` (8–255 printable non-whitespace chars).
- [x] `common/idempotency/idempotency.service.ts` — `claim()`, the atomic FR-B7
      guarantee.
- [x] Decorators: `@InternalOnly()`, `@SessionAuth()`, `@CurrentSession()`,
      `@RequireIdempotencyKey()`, `@IdempotencyKey()`.
- [x] `AuthModule` and `IdempotencyModule` are `@Global()` and wired into `AppModule`.
- [x] `npm run auth:hash -- '<password>'` generates a `DASHBOARD_PASSWORD_HASH`.

### Design decision: the interceptor does NOT short-circuit
The P2 plan said the interceptor should look the key up in `job_runs` and return
the existing run. It doesn't, deliberately: two concurrent n8n retries would both
miss that read and both proceed. The real guarantee is the **unique constraint on
`job_runs.idempotency_key`**, enforced by `IdempotencyService.claim()`, which
catches Prisma's `P2002` and returns the winning row. The interceptor validates
the header and attaches it; the service is the decision point. P5's runner must
call `claim()` — not re-read the key itself.

### Honest limitation: logout cannot revoke
Tokens are stateless, so `POST /api/auth/logout` (§8.3) can only tell the client
to discard its token — the token stays valid until it expires. Real revocation
needs a denylist table, which Phase 0 does not justify with one shared credential.
P13 should implement logout as a 204 and not pretend otherwise.

### ⚠ Two problems this phase surfaced
1. **`config/index.js` is side-effectful.** `ConfigModule.forRoot({ validate })`
   runs at *import* time (it is evaluated as a decorator argument), so importing
   the barrel anywhere validates the entire real environment — which broke unit
   tests. Fixed: `internal-token.guard.ts`, `session.service.ts` and
   `prisma.service.ts` now import `AppConfigService` from the leaf
   `config/app-config.service.js`. **Later phases must do the same** — never import
   `common/config/index.js` from inside `src/`.
2. **Prisma 7 model types are suffixed `Model`** — the type is `JobRunModel`, not
   `JobRun`, exported from `generated/prisma/models.js`. Every later phase that
   types a Prisma row hits this.

### Done when
- [x] Unit test: wrong/absent/prefix/empty internal token → 401; correct → passes.
- [x] Unit test: bad password, wrong email, and a malformed stored hash all → 401
      (fails closed, not a 500); good password → a token `session.guard` accepts.
- [x] Unit test: tampered payload, tampered signature, foreign secret, expired,
      and malformed tokens are all rejected.
- [x] **Integration test (§12)**: same `X-Idempotency-Key` twice → one `job_runs`
      row; **8 concurrent claims of one key → exactly 1 created, 1 row**. Tests
      clean up after themselves.
- [x] Runtime smoke test against the real `.env`: DI resolves every guard, the
      internal token guard accepts the configured token and rejects others, and
      `login()` against the real argon2 hash issues a token the session guard accepts.
- [x] `npm run build`, `npm run lint`, `npm test` (28 tests) all pass.

### Carried into later phases
- `.env` now holds a real argon2id `DASHBOARD_PASSWORD_HASH` for the dev password
  **`ChangeMe-Dev-2026!`** — change it before anything is deployed:
  `npm run auth:hash -- 'new-password'`.
- `vitest.config.ts` now loads `dotenv/config` via `setupFiles`, so integration
  tests get `DATABASE_URL`.
- Test helpers live in `test/support/` (`config.factory.ts`,
  `execution-context.ts`); excluded from the build.

---

## P3 — Notifications  ✅ COMPLETE

**Goal:** the outbound n8n webhook works and can never fail a job.
**Spec refs:** §4 (`Notifier`), §8.2 (FR-B13).

### Tasks
- [x] `notifications/notifier.interface.ts` — `Notifier`, `NotificationEvent`
      with the exact §8.2 payload, and the three event types as a union.
- [x] `notifications/n8n.notifier.ts` — POSTs to `N8N_ALERT_WEBHOOK_URL` with
      `X-Webhook-Token`, 5s timeout, one retry. Not a metered call; it is free.
- [x] **FR-B13** — every path logs and returns. `send()` has no throwing branch:
      network failure, non-2xx and timeout are all swallowed after logging at
      `error`. A notification failure cannot change a job's outcome.
- [x] Registered under the `NOTIFIER` token (FR-B1), so swapping n8n for
      anything else is one line in the module.

### Done when
- [x] A throwaway HTTP receiver confirms the §8.2 payload shape and the
      `x-webhook-token` header, and that `occurredAt` is filled when omitted
      and preserved when supplied.
- [x] A dead port resolves without throwing; a 500 resolves without throwing
      and is retried exactly once; a success is not retried.
- [x] 5 tests passing.

---

## P4 — Metering and cost enforcement  ✅ COMPLETE

**Goal:** a single choke point that makes overspending structurally impossible.
**Spec refs:** §6 in full (FR-C1, C2, C3, C4, C5, C9).

### Tasks
- [x] `common/domain/index.ts` — shared string unions (`SignalType`, `LeadBand`,
      `LeadStatus`, `JobStatus`, `SuppressionReason`, `DecisionReasonCode`).
      Added here because metering needs bands; used by every later phase.
- [x] `common/metering/metering.errors.ts` — `CapBreachedError`,
      `LeadBudgetExceededError`, `DailyBudgetGuardError`, `UnpricedCallError`.
- [x] `common/metering/spend.repository.ts` — MTD per provider, MTD total,
      today, per lead, per-provider breakdown. All aggregated in SQL. Period
      boundaries are UTC.
- [x] `common/metering/metered-client.ts` — the §6.1 order, exactly.
- [x] `common/metering/contact-resolution.policy.ts` + `.guard.ts` — FR-C5 as
      **one** implementation used by both the route guard and the service
      assertion, so they cannot drift apart.

### ⚠ Two deviations, both deliberate
1. **FR-C3 reads "MTD spend ≥ 80% of the daily budget"** — a month-to-date
   figure compared against a *daily* budget. Taken literally that trips
   permanently a day or two into every month and halts all non-priority work
   forever. Implemented as **today's spend vs. the daily budget**, which is
   plainly the intent. Flagged in a comment at the check.
2. **`computeCost` receives the whole result, not just `usage`.** §6.1 writes
   `computeCost: (usage) => ...`; for an `LlmProvider` the result *is*
   `{ result, usage }`, so this is the same value plus room for providers that
   bill in credits or requests rather than tokens.

### 🐛 Bug the acceptance test caught
`1.5 * 0.8` is `1.2000000000000002` in IEEE-754, so a daily budget spent to
exactly `$1.20` slipped past its own 80% threshold. All three money
comparisons now go through `atOrAbove()` with a 1e-9 tolerance. The same class
of error would have let a provider sit exactly on its hard cap and keep
spending.

### Done when — acceptance criterion A5
- [x] `GEMINI_MONTHLY_CAP_USD=0.01` with $0.011 already spent:
      **1.** the call is refused and `execute` never runs;
      **2.** a `cost.cap_breached` payload with the §8.2 shape reaches the notifier;
      **3.** `job_runs.status = 'failed'` with a readable error and `finishedAt` set;
      **4.** two further attempts are also refused, and `api_usage` gains no row.
- [x] Raising the cap resumes spending — the halt is not sticky state.
- [x] A provider with no override falls back to `MONTHLY_CAP_USD`.
- [x] FR-C1: `api_usage` records the ACTUAL computed cost, not the estimate.
- [x] FR-C4: an unapproved lead at its budget is refused; an **approved** lead
      is not, because the human has taken the decision.
- [x] FR-C3: `investigate` is refused at the threshold; `immediate` and `high`
      pass.
- [x] 9 tests passing.

---

## P5 — Job runner and `/internal/jobs/*`

**Goal:** n8n can trigger work over HTTP, safely and idempotently.
**Spec refs:** §7 in full, §8.1.

### Tasks
- [ ] `jobs/job.registry.ts` — map of `jobName → JobHandler`. Handlers register
      themselves from their own modules; the registry has no knowledge of specific jobs.
- [ ] `jobs/job.runner.ts`:
      - **FR-B5** `POST /internal/jobs/:jobName/run` returns **202 immediately** with
        `{ jobRunId, jobName, status }`. It never awaits the work. Kick off with a
        detached async call whose rejection is caught and written to `job_runs.error`.
      - **FR-B6** concurrency guard keyed on `jobName`. A second trigger for a running job
        returns 202 with `status: 'skipped'` and the in-flight run's id.
      - **FR-B7** `X-Idempotency-Key` required (reuse P2's interceptor).
      - **FR-B8** every run writes `counts`: fetched, deduped, filteredOut, enriched,
        classified, scored, briefed. These feed metrics M1–M8.
      - **FR-B9** per-record transactions, never per-batch. A mid-run failure leaves
        committed work intact.
      - On terminal failure, fire a `job.failed` notification.
- [ ] `GET /internal/jobs/runs/:jobRunId` → `{ status, startedAt, finishedAt, counts, error }`.
- [ ] `GET /internal/health` → `{ status, db, mtdSpendUsd }` (uses P4's spend repository).
- [ ] All three routes behind `@InternalOnly()`.

### ⚠ Design risk to resolve in this phase
FR-B6 specifies a Postgres **session-level** advisory lock (`pg_try_advisory_lock`). Prisma
runs each query on an arbitrary pooled connection, so a lock taken via `$queryRaw` is not
reliably held — or released — on the same connection for the life of a long job. Pick one
and write the choice into a comment at the lock site:

- **Recommended:** hold a dedicated `pg.Client` (`pg` is already installed — P1) for the duration of
  the run, take `pg_try_advisory_lock(hashtext($1))` on it, release in a `finally`.
- **Alternative:** a partial unique index on `job_runs(jobName) WHERE status = 'running'`,
  letting Postgres reject the second run. Simpler, but diverges from the spec's wording.

Do not use `pg_try_advisory_xact_lock` inside a Prisma interactive transaction — it would
hold a transaction open for the whole ingestion run.

### Done when
- Trigger a 10-second dummy job: the HTTP response returns in <100ms with a `jobRunId`.
- Triggering it again while running returns 202 `status: 'skipped'` with the same id.
- Same `X-Idempotency-Key` twice → one `job_runs` row (§12 test, now end-to-end).
- Killing the process mid-run leaves prior per-record commits in the DB (FR-B9).

---

## P6 — Companies: canonical domain, dedupe, suppression, fit filter

**Goal:** one company per real-world company, and out-of-ICP records die here.
**Spec refs:** §3 (`companies/`), parent spec §4.1.

### Tasks
- [ ] `companies/canonical-domain.ts` — pure function. Lowercase, strip scheme, strip
      `www.`, strip path/query/fragment, handle public-suffix correctly (`co.uk` is not a
      registrable domain). Reject free-mail and known aggregator domains.
- [ ] `companies/company.repository.ts` — upsert-by-`canonicalDomain`, which is the dedupe
      mechanism (the column is `@unique`).
- [ ] `companies/suppression.service.ts` — read/write `suppressionReason`
      (`client | competitor | rejected | do-not-contact`). Suppressed companies are
      excluded from every downstream stage.
- [ ] `companies/fit-filter.service.ts` — **config-driven rules**, thresholds read from
      `ScoringConfig`, never hard-coded. Produces a `fitScore: number` plus a pass/fail.
- [ ] Unit tests for the fit filter (required by §12): "config-driven rules behave as
      configured" — change a threshold in the config fixture, assert the outcome flips.
- [ ] Unit tests for `canonicalDomain` covering the `co.uk`, `www.`, and path cases.

### Done when
- Four spellings of the same domain resolve to one `Company` row.
- A suppressed company is invisible to a downstream query helper.
- Fit-filter tests pass with two different config fixtures.

---

## P7 — Signals: dedupe hash, persistence, compound detection

**Goal:** the same event from four sources becomes one signal.
**Spec refs:** §5 (`Signal`), §12, parent spec §5.

### Tasks
- [ ] `signals/dedupe-hash.ts` — pure function over the *semantic* identity of an event
      (companyId + type + normalised event date + a normalised subject), **not** over the
      source URL or the raw payload. Two outlets reporting the same funding round must
      collide.
- [ ] `signals/signal.repository.ts` — insert-on-conflict-do-nothing against
      `dedupeHash`. Count the conflicts; they are the `deduped` figure in job `counts`.
- [ ] `signals/compound.service.ts` — detect multiple distinct signal types on one company
      inside a window; emits a bonus capped at `+10` (§12).
- [ ] Persist the full source payload into `Signal.raw` (JSONB) — evidence for A3/A7.
- [ ] Unit tests (required by §12): "same round from four outlets produces one hash".
      Include the negative case — two genuinely different rounds must not collide.

### Done when
- The four-outlet test passes.
- Re-inserting an identical signal is a no-op and increments the dedupe counter.
- Compound bonus caps at +10 under a test with six concurrent signal types.

---

## P8a — Source: `sec-edgar`

**Goal:** the first live source, and the template every other source copies.
**Spec refs:** §4 (`SignalSource`), §7.2, §10 (FR-B21).

### Tasks
- [ ] `sources/signal-source.interface.ts` — exactly as §4. Define `RawSignal` and
      `SignalType` here; every source depends on these types and nothing else.
- [ ] `sources/source.registry.ts` — providers registered by name from config (FR-B1).
- [ ] `sources/sec-edgar/` — Form D filings since a watermark. Send `User-Agent:
      SEC_USER_AGENT` on **every** request; SEC fair-access requires it (FR-B21) and will
      block you without it. Respect SEC's rate limit (10 req/s) with a simple spacer.
- [ ] Watermark storage: persist `since` per source so a run resumes where the last
      finished. A missing watermark falls back to the request's `since` param.
- [ ] Register the `ingest.sec-edgar` job in the P5 registry; wire `counts`.
- [ ] Handle 429 with a simple backoff — no more sophistication than that (§14).
- [ ] Track consecutive failures per source; at 3, fire `source.unavailable` (§8.2).

### Done when
- `POST /internal/jobs/ingest.sec-edgar/run` produces real `Company` and `Signal` rows with
  dated signals and working `sourceUrl` values.
- **A2:** running it three times creates zero duplicate rows.
- `counts` on the run is populated and plausible.

---

## P8b — Source: `ats`

**Goal:** the second live source needed for acceptance A1. **Spec refs:** §7.2.

### Tasks
- [ ] `sources/ats/` with three adapters — greenhouse, lever, ashby — behind one
      `SignalSource` named `ats`. Each adapter maps a company's `atsProvider` + `atsSlug`.
- [ ] Job iterates **tracked companies only** (those with an `atsProvider` set), not the
      whole table.
- [ ] Discover and store `atsProvider`/`atsSlug` on `Company` when a board is found.
- [ ] Register `ingest.ats`.

### Done when
- **A1:** `sec-edgar` + `ats` together have produced ≥100 companies with dated signals and
  source URLs.
- Three consecutive runs → zero duplicates (A2).

---

## P8c — Sources: `hackernews`, `product-hunt`, `first-party`

**Goal:** the remaining Phase 0 inputs. **Spec refs:** §7.2, §8.1.

### Tasks
- [ ] `sources/hackernews/` — HN Algolia search for pain signals. Free, unauthenticated.
- [ ] `sources/product-hunt/` — recent launches, `PRODUCT_HUNT_TOKEN`.
- [ ] `sources/first-party/` — driven by `POST /internal/ingest/first-party` with body
      `{ domain, pageUrl, occurredAt, formType, email? }`, requires `X-Idempotency-Key`,
      returns `202 { accepted: true }`. This one is push, not pull.
- [ ] Register `ingest.hackernews` and `ingest.product-hunt`.

### Done when
- Each job runs clean and idempotently.
- The first-party endpoint rejects a missing idempotency key and is idempotent on replay.

---

## P9 — Enrichment

**Goal:** free enrichment that feeds the fit filter and the classifier.
**Spec refs:** §3, §4 (`Enricher`).

### Tasks
- [ ] `enrichment/enricher.interface.ts` — exactly as §4, including
      `readonly cost: 'free' | 'metered'`.
- [ ] `enrichment/homepage-fingerprint/` — fetch the homepage, detect modern stack and
      legacy markers. Writes `Company.detectedStack` and `Company.legacyFlags` (JSONB).
      Timeout aggressively; a slow site must not stall a run.
- [ ] `enrichment/dns/` — MX/NS/TXT lookups for hosting and mail-provider inference.
- [ ] `enrichment/github/` — org/repo activity via `GITHUB_TOKEN`. Free tier, but route it
      through `MeteredClient` anyway with `cost: 0` so rate usage is visible in `ApiUsage`.
- [ ] `enrichment/enrichment.service.ts` — runs all registered enrichers, sets
      `lastEnrichedAt`, tolerates individual enricher failure without failing the record.
- [ ] Register `maintenance.reverify-legacy` (weekly) to re-check `F-LEG` flags (FR-S5).

### Done when
- A known-legacy site is flagged; a known-modern site is not.
- One enricher throwing does not abort enrichment of that company or the run.
- `maintenance.reverify-legacy` updates stale `F-LEG` flags.

---

## P10 — Scoring engine

**Goal:** an explainable score, recomputed nightly, with the arithmetic in one place.
**Spec refs:** §5 (`ScoringConfig`), §7.2 (FR-B11), §8.3 (FR-B16), §12.

### Tasks
- [ ] `scoring/decay.ts`, `scoring/weights.ts`, `scoring/score.ts` — **pure functions**.
      No Prisma import anywhere in these files. Weights and half-lives are parameters,
      read from `ScoringConfig` by the caller.
- [ ] Band assignment: `immediate | high | investigate | ignore`.
- [ ] **FR-SC4**: no event signal newer than 30 days → band `ignore`, regardless of fit.
- [ ] `scoring/contributions.ts` — returns per-signal contributions **with decay already
      applied**, the exact shape `GET /api/leads/:id` will serve (FR-B16). The frontend
      renders; it never computes.
- [ ] `scoring/rescore.job.ts` — `score.rescore-all`. **FR-B11: one raw SQL
      `UPDATE ... FROM`**, not per-row Prisma writes. Must finish in <30 min over
      thousands of rows (NFR-4).
- [ ] Unit tests — this is the largest required test block in §12:
      - [ ] decay at t=0 equals the base weight
      - [ ] decay at one half-life equals half the base weight
      - [ ] a 180-day funding signal contributes < 1
      - [ ] FR-SC4: no event signal under 30 days → band `ignore` regardless of fit
      - [ ] compound bonus caps at +10

### Done when
- All five scoring tests pass.
- **A4:** running `score.rescore-all` twice a day apart lowers scores where no new signal
  arrived.
- **A3:** every lead exposes per-signal contributions summing to `totalScore`.
- `EXPLAIN ANALYZE` on the rescore statement confirms a single pass, and a 5,000-row
  fixture completes well inside 30 minutes.

---

## P11 — LLM layer: classify and brief

**Goal:** structured, cited, budget-bounded LLM output.
**Spec refs:** §11 in full, §4 (`LlmProvider`), §6.
**Precondition: P4's §6.3 acceptance test is green. Do not start otherwise.**

### Tasks
- [ ] `llm/llm-provider.interface.ts` — exactly as §4, including `batch` and
      `cacheSystem` flags.
- [ ] `llm/gemini/` — classify provider, model from `LLM_CLASSIFY_MODEL`
      (`gemini-2.5-flash-lite`). Constructor takes `MeteredClient` (FR-B2).
- [ ] `llm/anthropic/` — brief provider, model from `LLM_BRIEF_MODEL`. Constructor takes
      `MeteredClient`.
- [ ] **FR-AI2** structured output constrained by a Zod schema at both steps. No free-text
      parsing anywhere.
- [ ] **FR-AI3** brief uses the **batch endpoint** (50% cheaper). Nothing here is
      latency-sensitive. Gate on `LLM_BRIEF_BATCH`.
- [ ] **FR-AI4** prompt-cache the shared system prefix (ICP, service catalogue, scoring
      rubric). Identical across thousands of calls; cache reads cost ~10% of input.
- [ ] **FR-AI5** the classify schema must permit `has_rubico_opportunity: false` and
      `evidence_sufficient: false`, and either outcome **discards the record before
      scoring**. A classifier that never refuses is not a filter.
- [ ] **FR-AI6** programmatic brief validation: every claim carries a `signalId` that
      **exists in the database**. Verify in code with a real query. A brief with an
      uncited claim is rejected and logged as a defect, never surfaced to a human. Do not
      ask the prompt to enforce this.
- [ ] **FR-AI7** the suggested opening line references only cited evidence.
- [ ] Cost accounting: `computeCost` reads the P0 price table and distinguishes fresh
      input, cached input, output, and the batch discount.

### Done when
- **A6:** a deliberately irrelevant company returns `has_rubico_opportunity: false` and is
  discarded before scoring — committed as a test with a fixture company.
- **A7:** a brief fabricating a `signalId` is rejected by the validator and logged.
- Every LLM call produces exactly one `ApiUsage` row with a non-zero, plausible cost.
- Switching `LLM_CLASSIFY_PROVIDER` in `.env` changes providers with no code edit (FR-B20).

---

## P12 — `pipeline.run`

**Goal:** one job that walks enrich → classify → score → brief.
**Spec refs:** §7.2 (FR-B10).

### Tasks
- [ ] `jobs/pipeline.run.ts` — **a single job, not four chained ones** (FR-B10). Stage
      boundaries are visible in `counts`, which is why chaining buys nothing.
- [ ] Process all pending companies/leads: enrich → classify (discarding FR-AI5 refusals)
      → score → brief.
- [ ] Per-record transactions (FR-B9). One bad record does not abort the run.
- [ ] `counts` records every stage: fetched, deduped, filteredOut, enriched, classified,
      scored, briefed (FR-B8).
- [ ] Cap breach mid-run halts the pipeline, fires `cost.cap_breached`, marks the run
      `failed` — it does **not** degrade quietly (FR-C2).

### Done when
- A full run over ≥100 companies completes and every stage count is populated.
- Injecting a poison record fails that record only; the run finishes.
- Setting a $0.01 cap mid-run halts it and alerts (A5 again, now end-to-end).

---

## P13 — `/api/*` surface

**Goal:** everything the Next.js server layer needs, nothing the browser touches.
**Spec refs:** §8.3, §9.

### Tasks
- [ ] `npm i @nestjs/swagger` plus a zod→OpenAPI bridge. Every `/api/*` DTO carries
      swagger decorators (FR-B17); Zod stays the runtime validator (§9).
- [ ] All routes behind `@SessionAuth()`. **No CORS** (FR-B14). Bound to `127.0.0.1`
      (FR-B15).
- [ ] Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- [ ] Leads: `GET /api/leads?band=&status=&minScore=&page=&pageSize=`;
      `GET /api/leads/:id` returning the full record — brief, **per-signal score
      contributions with decay already applied**, evidence with source URLs (FR-B16);
      `POST /api/leads/:id/decision` writing a `Decision` (capturing `scoreAtDecision`,
      FR-B3) and updating `Lead.status`.
- [ ] Companies: `GET /api/companies/:id` — firmographics, stack, legacy flags, signal
      history.
- [ ] Contacts: `GET /api/contacts?leadId=`; `POST /api/contacts` for manual entry.
      `contacts/contact-resolver.interface.ts` is declared but has **only** a manual
      implementation in Phase 0. FR-C5 guard **and** service assertion both apply.
- [ ] Scoring config: `GET /api/scoring-config`, `PATCH /api/scoring-config` — weights and
      half-lives change with no deploy (FR-SC3). Record `updatedBy`.
- [ ] `outreach/outreach-sender.interface.ts` — **interface only, zero implementations**
      (§4, §14).

### Done when
- **A9:** contact resolution is unreachable for a lead not in `approved` status — proven
  through the route *and* by calling the service directly.
- `PATCH /api/scoring-config` followed by `score.rescore-all` changes scores with no
  restart.
- A lead detail response contains contributions the frontend can render without arithmetic.

---

## P14 — Digest, metrics, OpenAPI, acceptance sweep

**Goal:** close out Phase 0. **Spec refs:** §8.1 (FR-B12), §9, §13.

### Tasks
- [ ] `digest/` — `GET /internal/digest/daily?date=YYYY-MM-DD` returning
      `{ date, counts: { immediate, high, investigate }, leads: DigestLead[] }`. **Pull,
      not push** (FR-B12): n8n owns scheduling, so there is no webhook, no retry logic and
      no delivery-failure handling in the backend.
- [ ] `metrics/` — `GET /api/metrics/funnel?from=&to=` returning M1–M8, sourced from
      `job_runs.counts` (FR-B8) and the pipeline tables.
- [ ] `GET /api/metrics/spend` — MTD total, per provider, and cost per qualified
      opportunity, from `ApiUsage`.
- [ ] `npm run openapi:export` writing `openapi.json` to the repo root; serve the spec at
      `/openapi.json` in non-production only (FR-B17). Wire it into CI on merge to main.
- [ ] Note FR-B19 in the repo README: a breaking `/api/*` DTO change needs a matching PR in
      `rubico-lead-engine-web`. There is no cross-repo build enforcement and pretending
      otherwise is worse than acknowledging it.

### Done when — walk all ten of §13
- [ ] A1 two live sources, ≥100 companies with dated signals and source URLs
- [ ] A2 three re-runs of any ingestion job, zero duplicate rows
- [ ] A3 every lead has an explainable score with per-signal contributions
- [ ] A4 scores decrease overnight with no new signals
- [ ] A5 a $0.01 cap halts the pipeline and alerts n8n
- [ ] A6 the classifier returns `false` for a deliberately irrelevant company
- [ ] A7 no brief contains a claim without a valid `signalId`
- [ ] A8 `GET /api/metrics/funnel` returns M1–M8 with no manual queries
- [ ] A9 contact resolution is unreachable for a lead not in `approved` status
- [ ] A10 `openapi.json` at the repo root, current with `main`

---

## 3. Test inventory (§12 — deliberately narrow)

Five test groups. No HTTP-layer tests, no e2e, no coverage target.

| Test | Written in | Status |
|---|---|---|
| `scoring` unit tests (5 cases) | P10 | ☐ |
| `dedupeHash` unit tests | P7 | ☐ |
| Fit filter unit tests | P6 | ☐ |
| `MeteredClient` integration test (§6.3) | P4 | ✅ |
| Idempotency integration test | P2 | ✅ |

---

## 4. Anti-drift checklist

Re-read this before each phase; these are the ways this build goes wrong.

- Did you install `@nestjs/schedule`? Uninstall it. n8n schedules (§2).
- Did you call `enableCors()`? Remove it (FR-B14).
- Did a provider make a billable call without `MeteredClient`? That's an FR-B2 violation.
- Did you `new` a provider at a call site instead of resolving it by config name? FR-B1.
- Did scoring arithmetic leak into a controller or the frontend contract? FR-B16.
- Did you add Redis, BullMQ, a queue, Docker-in-prod, or a job dashboard? §14 — no.
- Did you build an outreach *implementation*? Interface only in Phase 0.
- Did you read `process.env` outside `common/config`? Route it through the config service.
- Did you widen scope past the six signals in parent spec §5? §14 — no.

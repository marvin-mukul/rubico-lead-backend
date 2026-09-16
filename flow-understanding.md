# Rubico Lead Engine — how the whole thing actually works

A single, step-by-step walk through the system: what goes in, what happens to
it, what comes out, which APIs are involved at each step, and why each rule
exists.

Read it top to bottom once and you will be able to answer: *"where did this
lead come from, and why does it have that score?"*

---

## 0. The one-paragraph version

Every morning the system goes out and reads public places on the internet
where organisations accidentally (or deliberately) announce that they have a
software problem — funding filings, job boards, Hacker News, Product Hunt,
government tender portals, press-release wires — plus anything typed into a
form on Rubico's own website. Each thing it finds is stored as a **signal**
attached to a **company**. Twice a day a pipeline walks the companies that
have a *fresh* signal, looks up what technology they run, checks a free
keyword gate, asks an AI model *"is there a genuine Rubico opportunity here,
and can you prove it from these signals?"*, throws away everything the model
refuses, gives what survives a **score** out of 100 and a **band**
(immediate / high / investigate / ignore), and writes a short **brief** a
salesperson can read in thirty seconds. Every morning at 09:00 the good ones
are posted to Slack, and a human opens the dashboard and approves or rejects
each one. Every approval and rejection is recorded, which is what eventually
tells you whether the engine is any good.

> **In plain terms**
> It is a machine that reads the internet looking for organisations that have
> just admitted they need software help, ranks them, writes a one-paragraph
> summary of each, and hands the list to a human every morning. The human is
> always the one who decides to contact anybody. The machine never sends an
> email.

---

## 1. The three pieces, and where each one lives

The system is deliberately split into three separately deployed parts. Each
owns exactly one kind of job, and none of them duplicates another's work.

| Piece | Repo | Deployed on | Owns |
|---|---|---|---|
| **Backend API** | `rubico-lead-engine-api` (this repo) | **Railway** — `https://rubico-lead-backend-production.up.railway.app` | *All* business logic: fetching, deduplication, enrichment, the gate, the AI calls, scoring, cost caps, the database |
| **Dashboard** | `rubico-lead-engine-web` (the `frontend` folder) | **Vercel** | The screens a human uses: queue, lead detail, decisions, metrics, funnel, scoring settings |
| **Workflows** | `rubico-lead-engine-n8n` | **n8n Cloud** — `https://aiwithmarvin.app.n8n.cloud` | Clocks, inbound webhooks, Slack messages, failure alerts |

### Why split it this way

- The backend **schedules nothing**. `@nestjs/schedule` is deliberately not
  installed, so a second scheduler cannot appear by accident. If something
  runs on a timer, n8n started it. One clock, one place to look.
- n8n **decides nothing**. It calls an HTTP endpoint, waits, and reports the
  result. No scoring rule, no filtering rule and no ICP rule lives in a
  workflow, so nobody can change how a lead is scored by editing a flow.
- The dashboard **computes nothing**. Every number it shows came from the
  backend. It never recalculates a score, so the screen and the database can
  never disagree.

> **In plain terms**
> n8n is the alarm clock and the messenger. The backend is the brain and the
> filing cabinet. The dashboard is the window you look through. Changing the
> clock cannot change the brain's opinion.

---

## 2. The daily timeline

All times are IST, set as cron expressions inside the n8n workflows.

| Time | Workflow | What it does |
|---|---|---|
| 03:00 | **W5 — Nightly rescore** | Re-scores *every* lead in the database so scores decay with age overnight. On Sundays it also re-verifies legacy-stack flags |
| 06:00 & 18:00 | **W1 — SEC EDGAR** | Reads new Form D funding filings |
| 06:30 | **W9 — Procurement** | Reads UK Contracts Finder and SAM.gov tender notices |
| 07:00 | **W2 — ATS boards** | Re-checks the job boards of companies already tracked |
| 07:15 | **W10 — Press releases** | Reads press-release RSS feeds |
| 07:30 | **W3 — HN + Product Hunt** | Reads Hacker News search results, then Product Hunt launches |
| 07:45 | **W11 — HN "Who is hiring?"** | Reads the monthly hiring thread — the main *discovery* source |
| 08:00 & 20:00 | **W4 — Pipeline run** | The main event: enrich → gate → classify → score → brief |
| 09:00 (Mon–Fri) | **W6 — Daily digest** | Posts the morning's leads to Slack |
| any time | **W7 — Alerts receiver** | Receives urgent alerts pushed by the backend, routes to Slack by severity |
| any time | **W8 — First-party intent** | Receives website form submissions and turns them into a signal |
| on failure | **W0 — Error handler** | Any workflow that fails triggers this; it posts to Slack, suppressing repeats of the same workflow within one hour |

Note the ordering: everything that *discovers* runs between 06:00 and 07:45,
and the pipeline that *spends money* runs at 08:00 — after the day's evidence
has landed, and an hour before the human reads the digest.

### The shape every ingest workflow shares

W1, W2, W3, W9, W10 and W11 are all the same five steps:

1. **Cron fires.**
2. `POST {API_BASE_URL}/internal/jobs/<job-name>/run` with the internal token
   and a fresh idempotency key. The backend returns **202 Accepted**
   immediately with a `jobRunId` — it does not wait for the work to finish,
   because fetching can easily outlast an HTTP timeout.
3. **"Job already running?"** — if the backend says `skipped`, stop here. A
   Postgres advisory lock guarantees two copies of the same job can never run
   at once.
4. **Wait 60s, then poll** `GET /internal/jobs/runs/{jobRunId}` in a loop
   (the pipeline waits 120s per poll, up to 20 iterations).
5. **Branch on the outcome** — success ends quietly; failure calls
   `stopAndError`, which fires W0, which posts to Slack.

> **In plain terms**
> Every workflow is "ring the doorbell, then keep knocking politely until
> someone answers, and shout if nobody ever does."

---

## 3. Stage one — discovery: where signals come from

A **signal** is one observable fact about one company, on one date, with a
link back to where it was seen. Nothing enters the system without a source
URL, which is what makes every later claim checkable.

There are nine signal types. Seven are **events** (something happened on a
date) and two are **standing properties** (something that is simply true
about the company).

| Type | Name | Source | What it means | Default evidence strength |
|---|---|---|---|---|
| **S1** | Funding | SEC EDGAR Form D | They raised money | E0 |
| **S2** | Hiring | Greenhouse / Lever / Ashby boards, and HN "Who is hiring?" | They are hiring engineers | E1 |
| **S3** | Pain signal | Hacker News (Algolia search) | Someone publicly described a technology problem | E1 |
| **S4** | Product launch | Product Hunt | They shipped something | E0 |
| **S5** | First-party intent | A form on Rubico's own website | **They contacted us** | E4 |
| **S6** | Procurement notice | UK Contracts Finder, SAM.gov, TED-EU | A public tender: they have declared, with a budget and a deadline, that they will buy | E3 |
| **S7** | Press release | PRNewswire technology RSS | They publicly *stated* an initiative | E2 |
| **F-LEG** | Legacy stack | Homepage fingerprinting | Their site runs genuinely obsolete technology | E0 |
| **F-PLAT** | Platform match | Homepage fingerprinting | Their site runs a platform Rubico staffs for (WordPress, WooCommerce, Shopify, Magento 2, Laravel) | E0 |

### The F-LEG / F-PLAT distinction, and why it matters commercially

These two look similar and mean opposite things:

- **F-LEG** says *"this should probably be rebuilt."*
- **F-PLAT** says *"we already have a team that works on this."*

Telling a company on WordPress that their stack is a defect, when Rubico sells
WordPress work, is exactly the mistake this split prevents. F-PLAT is a
**capability match** — an input to fit — and is scored at weight `0` on
purpose: *technology presence does not imply technology pain.*

### What each source actually is, and the API it calls

**SEC EDGAR (S1)** — `https://www.sec.gov/Archives/edgar/daily-index/...`.
Free, no key, but every request must carry `SEC_USER_AGENT` identifying
Rubico with a contact address or SEC blocks the client. It reads the *daily
form index* rather than the `getcurrent` feed, because `getcurrent` only
covers a few hours and its `type=` filter is a prefix match (`type=D` also
returns DEF 14A). Rate-limited to ~8 requests/second, max 10 days per run.
A weekend has no index and SEC answers 403 for it — the same status it uses
to block a client — so "every single day was missing" is treated as a block
and raises an error rather than silently reporting zero.

**ATS boards (S2)** — the public JSON endpoints of Greenhouse, Lever and
Ashby. No keys. Important limitation: this source only visits companies that
**already** have `atsProvider` and `atsSlug` on their row. It re-checks known
boards; it does not find new companies. `AtsSlugDiscoveryEnricher` is what
fills those columns in, by trying a small set of slug guesses derived from the
company's name and domain against each provider's API. (SmartRecruiters is
deliberately excluded from guessing: its API returns HTTP 200 with an empty
result for *any* identifier, so there is no "not found" to discover against.)

**Hacker News (S3)** — `https://hn.algolia.com/api/v1/search_by_date`. Free,
unauthenticated. The queries are configuration, not code
(`HACKERNEWS_QUERIES`): `legacy system`, `technical debt`, `migrating off`,
`rewrite our`, `replatform`, `rfp`, `looking for an agency`, `vibe coded`,
`ai generated code`, `built with replit`, `built with lovable`,
`stuck in prototype`, and more. A story only becomes a signal if it links
somewhere with a resolvable company domain — a discussion with no target
company is noise.

**Hacker News "Who is hiring?" (S2)** — the monthly thread, read as a company
**discovery** source. This exists because of a measured problem: of 644
companies in the database, 612 came from EU procurement, 11 from US
procurement and **four** from job boards. The engine had no way at all to find
a US software company. The September 2026 thread produced 256 top-level posts,
190 of which parsed to a company domain (74%), 183 unique companies, 23 of
them linking straight to an ATS board — which then becomes a continuous job
feed rather than a one-off post. Only "Who is hiring?" is read, never "Who
wants to be hired?" — that thread is individuals, and every row would be a
person misfiled as a company.

**Product Hunt (S4)** — the v2 GraphQL API at
`https://api.producthunt.com/v2/api/graphql`, using `PRODUCT_HUNT_TOKEN` (a
developer token, not billed). The `website` field is what makes a launch
usable: it is the company's own domain, unlike the producthunt.com post URL,
which the domain resolver rejects as an aggregator.

**Procurement (S6)** — UK Contracts Finder and SAM.gov by default; TED-EU
exists but is switched off in `PROCUREMENT_FEEDS`, because it dominated the
database. This is **the strongest evidence class the engine has.** A tender is
an organisation stating, in public, with a budget and a deadline, that it
intends to buy something. Everything else is inferred; a tender is declared.
It is also the breadth fix: the other sources reach software companies because
that is who posts to Hacker News. Procurement reaches schools, councils,
universities, NHS trusts and charities — which is what Rubico's real client
list looks like. A notice with no buyer contact email is dropped: a tender
that cannot be attributed to a company is worse than no tender.

**Press releases (S7)** — RSS, currently the PRNewswire
technology/computer-software feed. Free, no key, feed list is configuration
(`PRESS_RELEASE_FEEDS`). A release only becomes a signal if its own text names
a domain (the boilerplate "visit www.company.com" pattern) — it does not
attempt to guess a domain from a company name.

**First-party intent (S5)** — the only **push** source. A form on Rubico's
website posts to n8n's `POST /rubico/intent` webhook (W8), which extracts a
domain from the submitted email or referrer and forwards it to
`POST /internal/ingest/first-party`. Handled inline rather than as a job, since
it is a single row. This is the highest-value signal type in the system: it is
someone raising their hand.

> **In plain terms**
> Seven different places to listen, each hearing a different kind of "we have
> a software problem." A tender is someone shouting it with a cheque in their
> hand. A job posting is someone muttering it. A form fill on our own site is
> someone tapping us on the shoulder.

---

## 4. Stage two — ingestion: turning a found thing into a stored thing

Every source hands its findings to one shared `IngestionService`, so the rules
below exist exactly once and a source cannot bend them.

### Step 4.1 — Resolve the canonical domain

The company's identity *is* its domain, so four spellings of one company must
collapse to one string. `www.Acme.co.uk/careers?ref=x` → `acme.co.uk`.

Rejected outright:
- **Free mail providers** (`gmail.com`, `outlook.com`, `yahoo.com`, ~30 more).
  A Gmail address is a person, not a company.
- **Aggregators and shared platforms** (`github.com`, `linkedin.com`,
  `medium.com`, `vercel.app`, `greenhouse.io`, `producthunt.com`, `sec.gov`…).
  A page there identifies a *page*, not a company, and using the registrable
  domain would collapse every tenant onto one row.
- **Procurement intermediaries and shared public mailboxes**
  (`multiquote.com`, `in-tend.co.uk`, `jaggaer.com`, `nhs.net`…). Measured
  over 100 UK notices: `multiquote.com` fronted **17 different buyers** and
  `nhs.net` fronted 5. Without this list those would have merged into one
  company.
- IP addresses, and anything unparseable.

No domain means no company. The record is counted as `filteredOut` and
dropped — an expected outcome, not a failure.

### Step 4.2 — Upsert the company

The domain is the unique key. First sighting creates the row; every later
sighting attaches to it.

### Step 4.3 — Check suppression

A company can be marked `client`, `competitor`, `rejected` or
`do-not-contact`. Suppressed companies are counted and skipped — they never
reach scoring and never cost a penny.

### Step 4.4 — Deduplicate

This is the mechanism behind acceptance criterion A2. Every signal gets a
`dedupeHash`, and that column is **unique** in the database — the uniqueness
*is* the deduplication.

The hash covers the *semantic identity* of the event:

```
sha256( companyId | signalType | UTC-day-of-event | normalised-subject )
```

It deliberately **excludes** the source URL, source name, excerpt and raw
payload, because those describe *who reported it*. Including any of them would
give one funding round four rows when four outlets cover it. The subject is
normalised first — accents stripped, punctuation removed, whitespace collapsed
— so "Series A", "series-a" and "Series  A." are one event, not three.

Note the consequence: the event date, not the report date, is what buckets.
Two outlets covering the same Series A must agree on the date or they produce
two signals.

### Step 4.5 — Resolve evidence strength, then store

Before the row is written, `EvidenceService` assigns it a strength E0–E4 (see
§6.3). This is stored, not derived later, for two reasons: the nightly rescore
is a single set-based SQL `UPDATE` and cannot run 139 JavaScript regexes; and
strength is a property of the evidence **as observed** — recomputing it later
against edited patterns would silently rewrite history.

The full upstream payload is kept in `Signal.raw`, so any claim can be traced
back to exactly what the source said.

### A note on failure handling

Ingestion is **per record, never per batch**. One malformed row is counted and
skipped; everything committed before it stays committed. A run of 500 records
with one bad one produces 499 signals, not zero.

### Watermarks

Each ingest job remembers where it got to. The next run fetches from there,
with a hard floor of 90 days however stale the watermark is — evidence older
than a quarter cannot lift a company out of `ignore` anyway, and an expired
tender is context, not an opportunity.

---

## 5. Stage three — the pipeline: `pipeline.run`

This is the only job that spends money. It runs twice a day (08:00 and 20:00)
and is **one job, not four chained ones** — fewer moving parts in n8n, and the
stage boundaries are already visible in the run's `counts`.

### Step 5.0 — Choose who to look at

```
companies that are:
  NOT suppressed
  AND have at least one EVENT signal newer than `scoring.eventSignalFreshnessDays` (30)
ordered by: least-recently-examined first (never-examined first of all)
limit: `pipeline.batchLimit` (200)
```

Two details here are load-bearing:

**The freshness clause.** A company whose newest event is stale can only ever
band as `ignore`. Scoring it correctly and *paying* for it are different
things. Measured on real data, without this clause the pipeline enriched and
classified 117 of 640 companies every single run, forever, to produce leads
that could never be actionable.

**The ordering.** This used to be `firstSeenAt: desc` with the same limit of
200 — which meant the newest 200 companies were re-read every run and
everything older was **never** processed. With 523 eligible companies, 323 of
them were permanently invisible. Ordering by least-recently-examined turns the
batch limit into a throughput control instead of a permanent cut-off: the
whole eligible set cycles through in `eligible ÷ 200 ÷ 2` days.

Every company is marked as examined afterwards **whatever the outcome** —
filtered, discarded or errored. Marking only successes would leave the failures
with a null timestamp, permanently at the front of the queue, monopolising
every batch: the starvation bug inverted rather than fixed.

### Step 5.1 — Enrich (free)

If the company has not been enriched in 14 days, four enrichers run against
it. Each is wrapped in its own try/catch: homepages return 403, DNS times out,
GitHub rate-limits, and one enricher failing must not lose the results of the
other three.

| Enricher | API | Finds |
|---|---|---|
| **Homepage fingerprint** | Plain HTTPS GET of `https://<domain>/` (8s timeout, first 400KB, headers included) | The technology stack from HTML markers and `Server` / `X-Powered-By` headers → sets **F-LEG** and **F-PLAT** |
| **DNS** | Node's DNS resolver (MX and NS records) | Mail provider (Google Workspace, Microsoft 365, Proofpoint, Mimecast…) and DNS/host provider (Cloudflare, Route 53, Azure…) — a rough proxy for infrastructure age |
| **GitHub** | `api.github.com` org + repos, with `GITHUB_TOKEN` | Languages, repo count, last push date. Free at this volume, but routed through the cost meter at zero cost anyway so consumption is visible |
| **ATS slug discovery** | Public Greenhouse / Lever / Ashby APIs | Guesses the company's job-board slug from its name and domain, so the ATS source can track it continuously afterwards |

### Step 5.2 — The fit filter (free, and currently a *scorer*, not a gate)

`FitFilterService` adds up points across four dimensions plus three bonuses.
Every single rule is a row in `scoring_config` — nothing about the ICP is
hard-coded. The file only knows *how* to add points; never *which* attributes
are desirable.

```
headcount band   0–25   (51-200 employees scores highest at 25)
region           0–20   (namer 20, emea 15, apac 8)
country          0–10   (us 10, gb 10, in 8, ae 8)
industry         0–20   (saas 20, fintech 18, ecommerce 15…)
+ legacy stack   +15
+ platform match +10
+ ATS present    +5
```

**`fit.minScore` is deliberately set to 0**, which means this never blocks
anything. Here is why, and it is worth understanding because it is the single
biggest correction in the system's history:

Nothing currently populates firmographics — no enricher returns industry,
country, region or headcount — so all four dimensions always resolve to their
`.default` of 0, and the reachable maximum was 20 against a threshold of 40.
The filter therefore **rejected 100% of companies** and the pipeline had never
classified a single record. Rather than paper over it by lowering the
threshold, the gate was moved to a better question (§5.3): *"is there evidence
of a technology problem?"* rather than *"is this the right kind of company?"*
Industry is context, never a hard exclusion.

The fit score still contributes to the total (at half weight) — it just no
longer decides who gets paid for. `fit.minScore` remains as an operator kill
switch.

### Step 5.3 — The opportunity trigger: the real gate

This is the zero-cost, deterministic checkpoint between a company and the
first billable call. It runs the company's signal text against **12 trigger
families** defined in `config/triggers.json`, each a list of case-insensitive
regular expressions:

| Family | Catches | Suggests archetype |
|---|---|---|
| `ai-prototype` | "vibe coded", "built with lovable/replit/bolt/cursor/v0/claude", "AI-generated code", "prototype to production", "no-code", "low-code" | `ai_code_to_production` |
| `web-build` | website, web app, portal, intranet, CMS, WordPress, Drupal, Umbraco, Sitecore | `idea_to_product`, `fix_slowing_software` |
| `ecommerce` | ecommerce, checkout, cart, WooCommerce, Shopify, Magento, payment gateway, EPOS | `fix_slowing_software`, `idea_to_product` |
| `mobile-app` | mobile/iOS/Android app, React Native, Flutter | `idea_to_product`, `complex_engineering` |
| `modernisation` | legacy, modernise, replatform, migrate, rewrite, technical debt, end-of-life, mainframe, digital transformation | `fix_slowing_software` |
| `custom-software` | bespoke, custom software, CRM, ERP, LMS, case management, booking system, IT services | `idea_to_product`, `complex_engineering` |
| `integration-data` | integration, API, middleware, ETL, data migration, SSO, interoperability | `complex_engineering` |
| `performance-scale` | performance issues, slow, scaling, downtime, outage, high availability | `fix_slowing_software`, `complex_engineering` |
| `cloud-devops` | cloud migration, DevOps, CI/CD, Kubernetes, Docker, Terraform | `complex_engineering` |
| `quality-testing` | QA, test automation, Selenium, Cypress, penetration testing | `complex_engineering` |
| `capacity-expertise` | development partner, software agency/supplier, outsourcing, staff augmentation, framework agreement | `complex_engineering` |
| `tech-roles` | hiring a software/backend/frontend/DevOps/data engineer, CTO, Head of Engineering, Salesforce admin, solutions architect, product owner | `complex_engineering`, `fix_slowing_software` |

Three rules govern the gate:

1. **Any single family match admits the company.** It is tuned for *recall*,
   on purpose. A false negative silently drops a real opportunity and is
   unrecoverable — nothing downstream can rescue a signal the gate discarded.
   A false positive costs one classify call, about **$0.0002**, and the
   classifier is required to refuse cheaply. Precision belongs there, not here.
2. **Only event signals can open the gate.** F-LEG and F-PLAT are standing
   properties: running WordPress tells you what a company *has*, not that it
   *needs* anything. They are still reported as context when they match, but
   they cannot open the gate alone.
3. **Pre-qualified types skip the text test.** S5 (someone contacted us) and
   S6 (a tender that already passed a CPV/PSC-code relevance check at ingest)
   pass on their type alone. Re-testing their text only creates false
   negatives — a CPV-72 tender titled *"Software programming and consultancy
   services"* was being rejected by the phrase list.

Companies that fail the gate are counted as `noTrigger` and cost nothing.

> **In plain terms**
> Before we pay an AI to think about a company, a free keyword check asks:
> "did anybody, anywhere, say anything that sounds like a software problem?"
> It is set to be generous, because missing a real lead is expensive and a
> wrong guess costs two-hundredths of a cent.

### Step 5.4 — Classify (the first billable call)

See §7 for the full detail. In short: one AI call per company, with a schema
the model must fill in, and it is explicitly allowed — encouraged — to say no.

The verdict is recorded on the company row (`lastClassifiedAt`,
`lastClassifyKeep`, `lastClassification`) purely so a human can see it later
without re-running the model. Nothing reads it back; it cannot change what
the pipeline does.

**A refusal discards the record before scoring.** No lead row, no score, and
above all no brief is ever paid for.

### Step 5.5 — Score and upsert the lead

The surviving company gets scored (§6) and a `Lead` row is created or updated.

The key is `(companyId, opportunityKey)` where **`opportunityKey` is the
archetype the classifier chose.** This is what turns "one lead per company"
into "one lead per company per opportunity": a company already holding a
`fix_slowing_software` lead gets a **second row** for `ai_code_to_production`
the moment evidence for it appears, rather than an overwrite.

### Step 5.6 — Brief (the second billable call, batched)

A brief is requested **only** when the lead is brand new, or has never had a
brief. A stable, already-briefed opportunity that gets re-scored on a later
run does not regenerate its brief — that is what stops re-processing from
costing money twice.

All brief requests for the whole run are submitted as **one batch** at the
end, which is half price. Nothing here is latency-sensitive, so the 50%
discount is free money.

### What the run reports

`job_runs.counts` accumulates the stage boundaries, and these are the numbers
the funnel metrics are built from:

```
fetched → enriched → filteredOut → noTrigger → classified
       → discarded → scored → briefed → failed
```

### Failure handling, and the one exception

Per record: one company failing is counted and skipped; everything already
committed stays committed.

**Except a cost cap breach.** That is not a per-record problem — it means the
budget is gone — so it propagates immediately and halts the entire run rather
than being caught and counted 200 times. It is re-thrown *before* the company
is marked as examined, so that company keeps its place in the queue.

---

## 6. The scoring model, in full

Everything numeric here lives in the `scoring_config` table and is editable
from the dashboard without a deploy. Everything structural (which strength
maps to which ceiling, which archetypes exist) lives in a JSON file in
`config/`.

### 6.1 The formula

```
totalScore = clamp(0, 100,
    round( fitScore × fitWeight
         + intentScore × intentWeight
         + compoundBonus ) )
```

with `fitWeight = 0.5` and `intentWeight = 1`. Fit is 0–100 on its own, so it
is halved to leave room for intent to actually move a lead between bands.

### 6.2 Intent, and exponential decay

Each signal contributes:

```
contribution = weight × 0.5 ^ (ageInDays ÷ halfLifeDays) × evidenceMultiplier
```

That is a **half-life**: at zero days a signal is worth its full weight; at
one half-life it is worth half; at two half-lives a quarter. A funding signal
starts at 25 with a 30-day half-life, so after 180 days it contributes
`25 × 0.5⁶ = 0.39` — effectively nothing. Old news stops counting on its own,
with no cleanup job.

Current weights and half-lives:

| Type | Weight | Half-life | Why |
|---|---:|---:|---|
| **S6** procurement | 35 | 45d | Declared, budgeted, with a deadline — the strongest thing we can observe. Tenders close, so relevance falls off in a couple of months |
| **S5** first-party | 30 | 21d | Highest-value intent, fastest to go stale |
| **S1** funding | 25 | 30d | Short by design, so a six-month-old round is worth <1 |
| **S2** hiring | 20 | 45d | Slow-moving |
| **S7** press release | 20 | 60d | A stated initiative stays relevant for a couple of months |
| **S3** HN pain | 15 | 30d | |
| **F-LEG** legacy | 15 | 365d | A standing property, re-verified weekly |
| **S4** launch | 12 | 60d | |
| **F-PLAT** platform | **0** | 365d | Capability match, not a need. Feeds fit, never intent |

**Only the strongest surviving signal of each type counts toward intent.**
This is a deliberate decision, and an important one. Summing every signal
would let a company posting fifty jobs outscore a company with funding *and*
hiring *and* a public pain signal — and it would let F-LEG, re-verified every
week, grow without bound. Breadth is rewarded by the compound bonus instead,
which is exactly what compound detection is for.

Signals that lose to a stronger one of the same type are still reported to the
dashboard, marked `counted: false`, so the lead detail screen can show
everything that was considered.

### 6.3 Evidence strength (E0–E4)

Evidence strength answers one question: **how directly does this signal assert
a technology problem or an intent to buy?**

| Level | Meaning | Multiplier | Highest band it allows |
|---|---|---:|---|
| **E0** | Context — what they run, or who they are. Never an opportunity on its own | ×0.25 | `ignore` |
| **E1** | Inferred initiative — someone is doing something that implies a project | ×1 | `investigate` |
| **E2** | Stated initiative — the organisation says it is doing the thing | ×1.5 | `high` |
| **E3** | Declared requirement — the organisation says it needs a supplier | ×2 | `immediate` |
| **E4** | Direct inbound — they contacted us | ×2 | `immediate` |

Each signal type has a default strength, and **text patterns can raise it,
never lower it**. A tender that happens not to match any phrase is still a
tender. The raising patterns:

- **To E3**: "request for proposal/quotation/tender/information", "RFP",
  "RFQ", "RFI", "invitation to tender", "seeking an agency/partner/vendor",
  "accepting bids", "procurement of"
- **To E2**: "we are replatforming/migrating/rebuilding/modernising/replacing",
  "announces … platform/system/app/website", "has selected/chosen/appointed",
  "goes live", "now live", "embarking on", "kicks off … programme"

The ceilings are the mechanical form of a principle: **contextual evidence can
strengthen a real opportunity, but it can never create one.** That is a
statement about reachability, not weight, which is why it is a ceiling rather
than a multiplier — otherwise enough weak E0 signals could sum their way into
`high`. When a band is capped, the lead records *why*:

> *"Capped at investigate: strongest evidence is E1 (score alone would give high)"*

Evidence strength is kept deliberately separate from **attribution confidence**
("are we sure this is the right company?"). The SEC EDGAR failure was
attributional — a real funding event attached to the wrong company 12% of the
time — and a single axis cannot express *"good evidence, wrong company."*

### 6.4 The compound bonus

Several *different kinds* of signal arriving for one company inside a window
is worth more than the same signal repeating.

```
window                90 days
minimum distinct types 2
points per extra type  5
cap                   +10
```

So two distinct event types earn +5, three earn +10, four also earn +10 (the
cap). **Only event signals count** — F-LEG and F-PLAT are excluded, because
counting a permanent property would hand every legacy-stack company a
permanent bonus and stop the bonus meaning "several things are happening at
once."

### 6.5 Bands

| Band | Threshold | What the reviewer should do |
|---|---:|---|
| **immediate** | ≥ 70 | Contact this week |
| **high** | ≥ 50 | Worth a look |
| **investigate** | ≥ 30 | Maybe, on a slow day |
| **ignore** | < 30 | Not surfaced |

### 6.6 The freshness override

**If no event signal is newer than 30 days, the band is `ignore` — whatever
the score says.** A perfect-fit company with nothing happening is not a lead.
The lead records the reason:

> *"No event signal within 30 days (FR-SC4)"*

The same knob (`scoring.eventSignalFreshnessDays`) also decides who the
pipeline is willing to spend money on, so what we pay for and what can be
banded stay in step by construction rather than by two numbers that drift
apart.

### 6.7 A worked example

A UK council with:
- an **S6** procurement notice for a customer portal, 10 days old, E3
- an **S2** hiring signal for a .NET developer, 20 days old, E1
- fit score 25 (ATS present, legacy markers)

```
S6:  35 × 0.5^(10/45) = 30.00 × 2.0 (E3) = 60.00
S2:  20 × 0.5^(20/45) = 14.70 × 1.0 (E1) = 14.70
                                intent   = 74.70

compound: 2 distinct event types → +5
fit:      25 × 0.5              → +12.50

total = 74.70 + 5 + 12.50 = 92.20 → 92
band from score: immediate (≥70)
ceiling for strongest evidence E3: immediate
final band: IMMEDIATE
```

Change one thing — remove the tender, leaving only the hiring signal — and the
same company scores `14.70 + 0 + 12.50 = 27` → `ignore`, *and* would be capped
at `investigate` by the E1 ceiling anyway. That gap is the entire point of the
model.

### 6.8 The nightly rescore

Scores decay with time, so they must be recomputed, and it must finish inside
30 minutes over thousands of rows. `score.rescore-all` is therefore **one raw
SQL `UPDATE ... FROM`**, not per-row writes.

This duplicates the arithmetic that lives in TypeScript, which is an
acknowledged tension — set-based SQL cannot call a TypeScript function. The
mitigation is `rescore.parity.spec.ts`, a test that runs both implementations
over the same fixtures and fails if they disagree. The duplication therefore
cannot silently drift, which is the actual risk.

On Sundays, `maintenance.reverify-legacy` also re-checks legacy-stack flags —
a company that modernised its site should stop carrying F-LEG.

---

## 7. The classifier — where the AI is, and what it is allowed to do

There are exactly **two** places an AI model is called, and both go through
the cost meter.

### 7.1 Step one — classify

- **Model**: `gemini-3.5-flash-lite` (configurable via
  `LLM_CLASSIFY_PROVIDER` / `LLM_CLASSIFY_MODEL`)
- **Cost**: roughly **$0.0002** per company
- **Called**: once per company that passes the trigger gate

The prompt is split in two halves on purpose:

**The cached prefix** (identical on every single call, so it caches at ~10% of
normal input price) contains: who Rubico sells to, the four engagement
archetypes, the capability map, and the evidence rules. Nothing per-company,
no timestamp — a date in here would silently destroy the cache hit rate and
nothing would fail; the bill would just quietly go up.

**The per-call half** contains the company's facts and its signals, each with
its id, type, date, source and excerpt.

### 7.2 What the model must return

A strict schema, validated on the way back:

| Field | Meaning |
|---|---|
| `has_rubico_opportunity` | **false** when the company needs nothing Rubico sells |
| `evidence_sufficient` | **false** when the signals are too thin to justify a human's time |
| `likely_need` | One sentence on what they probably need |
| `archetype` | One of the four, or `"none"` |
| `rubico_capabilities` | Up to 6 named capabilities, drawn from the capability map |
| `why_this_lead` | 1–4 reasoning steps, each: **observation → implies → capability → signal ids** |
| `confidence` | low / medium / high |
| `reasoning` | Two sentences at most |
| `cited_signal_ids` | The ids that drove the decision |

The four archetypes (`config/archetypes.json`):

1. **`idea_to_product`** — starting with an idea, needing it built.
2. **`ai_code_to_production`** — built it in Lovable, Replit, Bolt or Claude
   and needs it secured, finished and shipped. **Rubico's hero offer.**
   Sub-types: production readiness, data security, user access management,
   scaling/performance, integrations, hidden technical blockers.
3. **`fix_slowing_software`** — an existing system slowing down, breaking, or
   costing too much to change.
4. **`complex_engineering`** — a hard engineering problem, or a need for
   capacity and expertise the team lacks.

### 7.3 The three rules that make the output trustworthy

**Rule 1 — it must be able to say no, and saying no is the point.**

> *"Both are normal, expected outcomes and most companies should receive one
> or both. A classifier that never refuses is not a filter: it doubles the
> cost of every downstream step and wastes the reviewer's attention. Refusing
> is the single most valuable thing you do."*

Either refusal discards the record **before** scoring. There is no lead row,
no score and no brief.

**Rule 2 — every claim must cite a real signal id, and this is checked in
code, not requested politely.** A classification that cites an id which does
not exist for that company is **discarded** — not repaired, not shown with a
warning. A `why_this_lead` step with an invented citation kills the whole
classification. The same applies to briefs: a brief that has been quietly
edited to remove a bad claim is no longer the thing that was validated.

**Rule 3 — what must *not* drive the decision.** The prompt states these
explicitly, because a prompt that merely removes a rule does not reliably stop
a model that learned it elsewhere:

- *Company size, headcount, funding stage, revenue or presumed budget.*
  Rubico's entry engagement is a $500, 48-hour package — cheap enough that a
  tiny team is routinely a great fit. "Looks too small to be worth it" is
  named in the prompt as a **reasoning error**, not judgement. A two-person
  team with a broken-auth AI-built app launching next week is called out as an
  **excellent** fit.
- *Industry.* Context for reasoning, never a reason to say yes or no alone.
- *Whether they already run a technology Rubico services.* Running WordPress
  tells you what they run, not that they need help with it.

The ICP is also explicitly broad: *"software companies are valid customers but
are a minority of Rubico's actual client base, which includes universities,
manufacturers, insurers, nonprofits, government bodies and agencies. Do not
narrow the ICP to 'tech companies'."* Agencies and consultancies are the one
clear "poor fit" — they are competitors.

### 7.4 Step two — the brief

- **Model**: `claude-sonnet-5` (configurable)
- **Cost**: roughly **$0.002** per lead, **halved** by batching
- **Called**: once per *new* opportunity, in one batch at the end of the run

It returns:

| Field | Meaning |
|---|---|
| `headline` | One line: who they are and why now |
| `claims` | 1–8 claims, **each carrying its own `signal_id`** |
| `suggested_opening_line` | Something the recipient would recognise as true about their own company this month |
| `opening_line_signal_ids` | The ids backing that line specifically |
| `risks` | Up to 4 reasons this might not be a fit |
| `confidence` | low / medium / high |

Making the citation part of the claim's *shape*, rather than a list at the
end, is what makes "which claim is unsupported?" answerable per claim. A brief
that fails validation is rejected outright and logged; the lead keeps its
score and stays visible, it simply has no brief.

> **In plain terms**
> The AI is allowed to write only sentences it can point at a source for. If
> it points at a source that does not exist, the whole thing is thrown away
> rather than shown to a person with the bad sentence quietly deleted. That is
> the difference between a summary you can act on and one you have to
> double-check.

---

## 8. Cost control — the thing standing between this and a surprise bill

Every billable outbound call — both AI steps, and GitHub at zero cost — goes
through one function, `MeteredClient.call()`. There is no second path.

It runs five checks in order:

1. **Hard per-provider monthly cap.** If month-to-date spend for that provider
   has reached its cap, the call is **rejected**, an alert is pushed to n8n,
   and the job run is marked failed. It **halts**; it does not degrade
   quietly. That is the entire point of a cap.
2. **Per-lead pre-approval budget** (`PER_LEAD_BUDGET_USD = $0.10`). Bounds
   what may be spent on a lead *before* a human approves it. Once approved,
   the human has taken the decision and this no longer applies.
3. **Daily guard.** Once today's spend reaches 80% of the daily budget
   ($1.50 × 0.8 = $1.20), only `immediate` and `high` band leads may still
   spend. Everything else is cut off for the day.
4. **Execute.**
5. **Write an `api_usage` row with the *actual* cost**, computed from the
   provider's own reported token usage against `config/pricing.json`. No
   exceptions — every call leaves a row.

Money is floating-point summed by Postgres, so comparisons use a tolerance of
1e-9: `1.5 × 0.8` is `1.2000000000000002`, and a budget spent to exactly $1.20
would otherwise slip past its own threshold.

Current caps: **$25/month total, $1.50/day, $0.10 per unapproved lead.**

The `api_usage` table existing in the very first migration is not an accident —
retrofitting it would mean retrofitting every call site.

> **In plain terms**
> One doorway, and a bouncer on it who checks the month's budget, this lead's
> budget and today's budget before letting anything through, and writes down
> exactly what every call cost on the way out. If the month's money runs out
> the system stops and shouts, rather than carrying on and hoping.

---

## 9. Where a human comes in — the dashboard

The dashboard is a React SPA on Vercel. The browser never talks to the backend
directly across origins: `vercel.json` rewrites `/api/*` to the Railway
backend, so everything stays same-origin. This is required, because the
backend runs with **CORS disabled entirely** and the session is an httpOnly
cookie — no token is ever read, held or sent by JavaScript.

### The screens

| Route | Purpose |
|---|---|
| `/` **Queue** | Today's list, grouped by band with counts, ordered by score. Mirrors the Slack digest exactly, from the same data, so the two can never disagree. Leads decided today stay visible and read as done — removing a row on decision makes a 20-lead session feel like it is going backwards |
| `/leads` | The full list, filterable and sortable by score or recency |
| `/leads/:id` | **The core screen.** Ordered deliberately: header → why now → opportunity → evidence → score breakdown → suggested opening line → decision. A reviewer reads down it once and decides |
| `/companies/:id` | The company behind a lead, and all of its signals |
| `/metrics` | M1–M8 with a date range, plus spend |
| `/funnel` | Look *inside* the numbers — the actual rows behind each stage count |
| `/settings/scoring` | Every weight, half-life, band threshold and fit rule, editable |

### The review flow

The Day-30 review is 45 minutes through 20 briefs with a management reviewer.
Every second of friction costs evidence, and a two-hour session is one that
does not get scheduled again. So:

- After recording a decision, the reviewer goes **straight to the next
  undecided lead** — never back to the list.
- The next lead is **prefetched on mount**, so the screen is instant. The
  reviewer must never watch a spinner between leads.
- Keyboard shortcuts drive the whole session; `j` moves to the next lead
  whether decided or not.
- The search moves forward only — wrapping to the top would re-show leads
  already passed over.

### What a decision records

`POST /api/leads/:id/decision`:

- `decision` — `approved` or `rejected`
- `reasonCode` — one of twelve: `good`, `wrong_fit`, `stale`, `already_known`,
  `no_real_need`, `bad_contact`, plus six added specifically so the engine can
  be *tuned*: `wrong_archetype`, `no_technology_need`, `evidence_too_weak`,
  `wrong_capability`, `platform_not_problem`, `attribution_error`. The
  original six could not express "right company, wrong archetype", so the
  trigger rules, capability map and evidence weights had no ground truth to
  tune against.
- `notes` — free text
- **`scoreAtDecision`** — the score the human *actually saw*, captured at
  decision time and never re-read from the lead afterwards. The lead's score
  moves every night; calibration needs the number that was on screen.
- **`attribution`** — `management` or `builder`. See §10.

### Contact resolution is gated on approval

`POST /api/contacts` is unreachable for a lead that is not `approved`. This is
enforced twice — by a guard on the route *and* by an assertion inside the
service — because the service will later be called from a job as well as a
route. It is one implementation used in both places, not a duplicated rule.

---

## 10. M1–M8: the funnel metrics, and what each one is for

These are the numbers that answer *"is this engine working?"* They come from
two places: the per-stage `counts` that every job run writes, and the pipeline
tables themselves.

`GET /api/metrics/funnel?from=…&to=…` (default window: the last 30 days).

| Metric | What it counts | Where it comes from | The question it answers |
|---|---|---|---|
| **M1** | Signals ingested | `signal` rows observed in the window | *Are we finding anything at all?* If this is flat, a source has broken |
| **M2** | Companies discovered | `company` rows first seen in the window | *How many distinct organisations did that reach?* M1 ÷ M2 shows whether one company is dominating |
| **M3** | Passed the fit filter | Everything that reached classification | *How many survived screening?* Currently equal to M4 by construction, since the fit filter no longer gates |
| **M4** | Classified | `classified` count from pipeline runs | *How many did we actually pay to think about?* This is the cost driver — multiply by ~$0.0002 |
| **M5** | Discarded by the classifier | `discarded` count | *How often does the AI say no?* **The most diagnostic number here.** A 0 means the classifier is not filtering and is doubling downstream cost. A 100% means the gate is admitting rubbish, or the prompt is too strict |
| **M6** | Leads scored | `scored` count | *How many opportunities came out?* M4 − M5 |
| **M7** | Briefs generated | `briefed` count | *How many were worth writing up?* A gap between M6 and M7 means briefs are failing citation validation |
| **M8** | Decisions | `decision` rows, split by attribution | *What did the human think?* Approved, rejected, approval rate, and the mean score of each |

Alongside these, `byBand` breaks the window's leads into immediate / high /
investigate / ignore, and `GET /api/metrics/spend` returns month-to-date
spend, today's spend, the cap, a per-provider breakdown, and
**cost per qualified opportunity** — total spend ÷ approved leads. That last
number is the one that decides whether the engine is worth running at all.

### The management / builder split

M8 is reported three times: overall, `management` only, and `builder` only.

**Only `management` counts as validation.** The Day-30 review is the builder
sitting with a management reviewer and recording their verdicts, and a
builder's own opinion of their own engine is not evidence. Rolling the two
together produces a number that *looks* like validation and is not, which is
worse than having no number at all. `attribution` defaults to `builder`,
which is the conservative direction — an unlabelled decision understates the
headline metric rather than inflating it.

### The funnel screen: looking inside the numbers

`/funnel` pairs each metric with the actual rows behind it:

| Tab | Shows | Filters |
|---|---|---|
| **M1 · Signals** | Every ingested signal, newest first, with its type, evidence strength, source link and excerpt | Date range, source — plus a per-source breakdown that stays complete even while one source is selected, so filtering to "hackernews-hiring" does not lose the comparison that made you want to filter |
| **M2 / M3 · Companies** | Every discovered company, its signal count, and whether it passes the fit check *right now* | Date range, source |
| **M4 / M5 · Classified** | Every classification: kept or discarded, the reason, the likely need, the archetype, the contact email | Date range, source, kept/discarded |
| **M6 / M7 · Leads & briefs** | The leads themselves | |

Two design rules on this screen: the M3 fit check is recomputed **live through
the exact service the pipeline itself calls** — never a second implementation
— so it can differ from what M3 counted historically (config may have changed
since) but never from what the real check would do today. And **nothing on
this screen changes what the pipeline does**: there is no trigger, override or
bypass button. Acting on something you spot means going to the lead and
deciding, through the normal flow. Every row links straight to its lead where
one exists, so a business-development reach-out lands on the full lead page
rather than a bare company profile.

---

## 11. The complete API surface

Three namespaces, three authentication models.

### `/internal/*` — n8n only, `X-Internal-Token` header

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/jobs/:jobName/run` | Start a job. Returns **202** with a `jobRunId`, or `skipped` if that job is already running. Requires `X-Idempotency-Key` |
| `GET` | `/internal/jobs/runs/:jobRunId` | Poll status: `queued` / `running` / `succeeded` / `failed` / `skipped`, plus per-stage counts |
| `GET` | `/internal/digest/daily?date=` | The day's leads for Slack — band counts, and per lead the score, likely need, archetype, brief headline and one representative evidence URL. A **pull** endpoint on purpose: n8n already owns scheduling, so the backend needs no webhook URL, no retry logic and no delivery-failure handling for it |
| `POST` | `/internal/ingest/first-party` | A website form submission → an S5 signal. Requires `X-Idempotency-Key` |
| `GET` | `/internal/health` | Database reachable, and month-to-date spend. The fallback signal when alerts are not arriving |

Job names: `ingest.sec-edgar`, `ingest.ats`, `ingest.hackernews`,
`ingest.hackernews-hiring`, `ingest.product-hunt`, `ingest.procurement`,
`ingest.press-release`, `pipeline.run`, `score.rescore-all`,
`maintenance.reverify-legacy`.

Handlers register themselves from their own modules, so adding a source is a
provider plus one registry line — never a new job implementation and never an
edit to a call site.

### `/api/*` — the dashboard, session cookie

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Email + password (argon2id hash) → httpOnly session cookie |
| `POST` | `/api/auth/logout` | |
| `GET` | `/api/auth/me` | Who is signed in |
| `GET` | `/api/meta` | The enum vocabularies — bands, statuses, reason codes, sorts, attributions — so the UI never hard-codes a list that the backend might extend |
| `GET` | `/api/leads` | The list: filter by band and status, sort by score or recency |
| `GET` | `/api/leads/:id` | The full lead: score **with per-signal contributions and decay already applied**, evidence, classification, brief |
| `POST` | `/api/leads/:id/decision` | Record approved/rejected + reason code + notes |
| `GET` | `/api/companies/:id` | The company and its signals |
| `GET` | `/api/contacts?leadId=` | Contacts resolved for a lead |
| `POST` | `/api/contacts` | Resolve a contact — **403 unless the lead is approved** |
| `GET` | `/api/scoring-config` | Every knob, plus `lastRescoreAt` |
| `PATCH` | `/api/scoring-config` | Change knobs. Takes effect at the next nightly rescore, and the screen says so |
| `GET` | `/api/metrics/funnel` | M1–M8 |
| `GET` | `/api/metrics/spend` | Spend, cap, cost per qualified opportunity |
| `GET` | `/api/funnel/signals` | M1 rows |
| `GET` | `/api/funnel/companies` | M2 / M3 rows |
| `GET` | `/api/funnel/classifications` | M4 / M5 rows |

`/api/*` request and response shapes are declared **once**, as Zod schemas.
The OpenAPI document is generated from those same schemas, so validation and
contract cannot drift. The frontend generates its TypeScript types from
`openapi.json` — no hand-written duplicates, no published package.

There is, honestly, **no build-time enforcement across the two repos.** A
breaking DTO change requires a companion PR on the frontend, and nothing here
will fail if you skip it — the frontend simply breaks at runtime after its
next type generation. Re-run `npm run openapi:export` and commit the result in
the same PR.

### `/openapi.json` — no auth, non-production only

In production the contract is the committed `openapi.json`, not a live
endpoint.

### Outbound: backend → n8n

`POST {N8N_ALERT_WEBHOOK_URL}` with `X-Webhook-Token`, for urgent unscheduled
events only — cost cap breaches, a source that has been down long enough to
matter. Two attempts, 5-second timeout, then **swallowed**: a notification
failing must never fail a job. It logs loudly and the health endpoint is the
backstop.

Everything *scheduled* is pulled by n8n instead, which is why there is only
one outbound webhook in the whole system.

### External APIs, in one place

| API | Auth | Cost | Used for |
|---|---|---|---|
| SEC EDGAR daily index | `SEC_USER_AGENT` (mandatory) | Free | S1 |
| Greenhouse / Lever / Ashby | None | Free | S2, slug discovery |
| HN Algolia | None | Free | S3, S2 (hiring thread) |
| Product Hunt GraphQL v2 | `PRODUCT_HUNT_TOKEN` | Free | S4 |
| UK Contracts Finder, SAM.gov, TED-EU | None | Free | S6 |
| PRNewswire RSS | None | Free | S7 |
| GitHub REST | `GITHUB_TOKEN` | Free | Enrichment |
| DNS | — | Free | Enrichment |
| Company homepages | — | Free | F-LEG / F-PLAT |
| **Google Gemini** | `GEMINI_API_KEY` | **Billed** | Classification |
| **Anthropic Claude** | `ANTHROPIC_API_KEY` | **Billed** | Briefs |
| Slack | OAuth2 (in n8n) | Free | Digest, alerts |

Only the two AI providers cost money. Everything else is free and
rate-limited by politeness.

---

## 12. Configuration — what you can change without a deploy

| Where | Holds | Changing it |
|---|---|---|
| **`scoring_config` table** | Every *number*: weights, half-lives, evidence multipliers, band thresholds, compound settings, freshness window, batch limit, every fit rule | Live, from `/settings/scoring`. Applies at the next nightly rescore |
| **`config/triggers.json`** | The 12 trigger families and their patterns | Edit + restart |
| **`config/evidence.json`** | E0–E4 defaults per signal type, the raising patterns, the band ceilings | Edit + restart |
| **`config/archetypes.json`** | The four archetypes and their sub-types | Edit + restart |
| **`config/capability-map.json`** | The technology families Rubico staffs for, its service lines and segments | Edit + restart |
| **`config/pricing.json`** | Per-model token prices | Edit + restart |
| **Environment** | Which model, which provider, which feeds, which HN queries, the caps | Redeploy |

The division is deliberate: numbers live in the database because a human
tunes them from a screen; structure lives in JSON because it is edited as a
shape, not a value. The archetype and capability sections of the AI prompt are
*built* from those JSON files rather than duplicated in the prompt text — one
source of truth, and the built string is still byte-identical across every
call in a process's lifetime, so prompt caching is unaffected.

Signal types, bands, statuses and reason codes are stored as plain strings in
the database rather than SQL enums, so adding a value is a config change
rather than a migration.

---

## 13. Deployment

### Backend — Railway

`https://rubico-lead-backend-production.up.railway.app`

Needs: Node 24, PostgreSQL 16, and every variable in `.env.example` set. Boot
**fails fast** on anything missing or malformed — that is intentional, so a
half-configured deploy never runs and quietly produces nothing.

Before first traffic: `npm run db:migrate` then `npm run db:seed` (the seed
creates the scoring defaults and **never overwrites a value a human has
tuned**).

Two settings to watch on a platform deploy:

- **`BIND_ADDRESS`** defaults to `127.0.0.1`, which is correct when the API
  and the SPA are served from one origin behind a reverse proxy. Railway
  routes to the container, so this must be `0.0.0.0` there or nothing reaches
  the service.
- **`NODE_ENV=production`** turns off `/openapi.json`. Type generation must
  then use the committed file.

Required variables:

```
DATABASE_URL  NODE_ENV  PORT  BIND_ADDRESS
INTERNAL_API_TOKEN  SESSION_SECRET            (≥32 chars each)
DASHBOARD_EMAIL  DASHBOARD_PASSWORD_HASH      (npm run auth:hash -- '<password>')
N8N_ALERT_WEBHOOK_URL  N8N_WEBHOOK_TOKEN
LLM_CLASSIFY_PROVIDER  LLM_CLASSIFY_MODEL
LLM_BRIEF_PROVIDER  LLM_BRIEF_MODEL  LLM_BRIEF_BATCH
GEMINI_API_KEY  ANTHROPIC_API_KEY
GITHUB_TOKEN  PRODUCT_HUNT_TOKEN
MONTHLY_CAP_USD  DAILY_CAP_USD  PER_LEAD_BUDGET_USD
SEC_USER_AGENT  SEC_DOMAIN_RESOLVER
HACKERNEWS_QUERIES  HN_HIRING_THREADS
PRESS_RELEASE_FEEDS  PROCUREMENT_FEEDS
PRICE_TABLE_PATH  CAPABILITY_MAP_PATH  ARCHETYPE_PATH  TRIGGER_PATH  EVIDENCE_PATH
```

### Frontend — Vercel

`vercel.json` rewrites `/api/*` to the Railway backend. That rewrite is not a
convenience — it is what keeps the browser on a single origin. The backend
sends no CORS headers at all, and the session cookie is `SameSite=Lax` and
httpOnly; a cross-origin base URL breaks both. **Leave `VITE_API_BASE_URL`
unset.**

Locally, the Vite dev server proxies the same path to `localhost:3000`, so
development and production behave identically.

### n8n — Cloud

`https://aiwithmarvin.app.n8n.cloud`

Three credentials, created in the n8n UI and referenced **by name only** in
the workflow JSON, so no secret is ever committed:

| Name | Type | Used by |
|---|---|---|
| `Rubico API — Internal Token` | Header Auth, `X-Internal-Token` = backend's `INTERNAL_API_TOKEN` | W1–W6, W8 |
| `Rubico Backend — Webhook Token` | Header Auth, `X-Webhook-Token` = backend's `N8N_WEBHOOK_TOKEN` | W7, W8 |
| `Rubico Slack` | Slack OAuth2 | W0, W6, W7 |

Instance variables:

```
API_BASE_URL   = https://rubico-lead-backend-production.up.railway.app
DASHBOARD_URL  = <the Vercel URL>
SLACK_CHANNEL_DIGEST = lead-engine
SLACK_CHANNEL_ALERTS = lead-engine-alerts
```

`API_BASE_URL` must be the **backend** (port 3000 locally), never the
frontend, and never `localhost` — these workflows run on n8n Cloud, where
`localhost` resolves inside n8n's own container.

Import order for a fresh instance: create the credentials, create the
`workflow_error_alerts` data table, import and publish **W0 first** (n8n
refuses to set an unpublishable workflow as an Error Workflow), then import
W1–W11, attach credentials, publish each, and set W0 as the Error Workflow in
each one's Settings.

> **The committed JSON has drifted from the live instance.** Verified against
> n8n Cloud on 2026-09-16:
>
> - **Live uses `$vars.X`; the export uses `$env.X`.** The Cloud plan does not
>   expose `$env` for custom variables, so the instance was moved to n8n's
>   built-in Variables feature — but the exports were never re-taken.
>   Re-importing a workflow file as-is would give every node an undefined
>   `API_BASE_URL` and `DASHBOARD_URL`.
> - **W0 *is* wired as the Error Workflow** (`SJERKYjPwsGI9Fw5`), contrary to
>   the README's "none yet in this export" — spot-checked on W1, W4 and W6.
> - **All 12 workflows are active**, and W9/W10/W11 have real IDs now
>   (`8BsUR8ISVdSdG7te`, `EKAJN9EXPW37zq0E`, `TyMkwEhld7ZooIxk`).
> - The Slack credential is named `Slack account`, not `Rubico Slack`.
>
> Re-exporting all 12 from the live instance would close this. Until then,
> **live is the source of truth, not the repo.**

---

## 14. End-to-end, one lead's whole life

Follow a single record all the way through.

1. **06:30 IST** — n8n W9 fires and calls
   `POST /internal/jobs/ingest.procurement/run`. The backend takes an advisory
   lock, returns `202 { jobRunId }`, and starts working in the background.
2. The procurement source reads UK Contracts Finder since its watermark. One
   notice reads *"Replacement customer self-service portal — Borsetshire
   Council"*, CPV 72000000, buyer email `procurement@borsetshire.gov.uk`.
3. **Relevance** — the CPV code is a technology code, so the notice passes.
4. **Domain** — `borsetshire.gov.uk`, which is not free mail, not an
   aggregator, not a procurement intermediary. Accepted.
5. **Company** — no row exists, so one is created.
6. **Dedupe hash** — `sha256(companyId|S6|2026-09-14|replacement customer self service portal borsetshire council)`. No collision, so the signal is written.
7. **Evidence strength** — S6 defaults to **E3**, and the text does not raise
   it further. Stored as E3.
8. **07:00** — W2 runs. The council has no ATS slug yet, so nothing happens here.
9. **08:00** — W4 fires `pipeline.run`.
10. **Pending?** The council has an event signal 0 days old, is not
    suppressed, and has never been examined — so it is at the very front of
    the queue.
11. **Enrich** — the homepage returns Drupal 7 markers → **F-LEG** is set.
    DNS shows Microsoft 365. No GitHub org. ATS slug discovery finds nothing.
12. **Fit** — `+15` legacy stack, everything else defaults to 0 → fit 15.
    `minScore` is 0, so it passes.
13. **Trigger gate** — the notice text matches `web-build`
    ("customer portal") and `modernisation` ("replacement"). The signal is an
    event, and S6 is pre-qualified anyway. **Gate opens.**
14. **Classify** — Gemini is asked. It answers
    `has_rubico_opportunity: true`, `evidence_sufficient: true`,
    `archetype: fix_slowing_software`,
    `likely_need: "Replace an ageing Drupal 7 self-service portal"`,
    `rubico_capabilities: ["Laravel", "PHP", "UX/UI"]`, and a
    `why_this_lead` chain citing the tender's signal id. **Cost: $0.0002.**
    Every cited id is checked against the database; all exist, so it is kept.
15. **Score** —
    `S6: 35 × 0.5^(0/45) × 2.0 = 70.0` intent; compound `0` (one type only);
    fit `15 × 0.5 = 7.5`; total `77.5 → 78`. Band from score: **immediate**.
    Ceiling for E3: immediate. Band stands.
16. **Lead** — created with `opportunityKey = "fix_slowing_software"`.
17. **Brief** — requested, batched with the rest of the run, written by Claude
    at half price. Every claim carries a signal id; validation passes; the
    brief is saved. **Cost: ~$0.001.**
18. **Counts** — the run records `classified +1`, `scored +1`, `briefed +1`,
    which is what M4, M6 and M7 will report.
19. **09:00** — W6 pulls `/internal/digest/daily`, sees one `immediate` lead,
    and posts it to `#lead-engine`: band emoji, company name, score, the
    brief's headline, the archetype, a link to the dashboard and a link to the
    tender itself.
20. **A human opens `/leads/:id`** and reads: the headline, why now, the
    opportunity, the tender itself with a link to the original notice, the
    score broken down signal by signal with decay shown, and a suggested
    opening line.
21. **They press approve**, pick reason `good`, attributed to `management`.
    The decision is stored with `scoreAtDecision: 78` — the number that was
    actually on screen.
22. **Contact resolution** is now unlocked for this lead, and not before.
23. **03:00 tomorrow** — the nightly rescore runs. The tender is one day older,
    so the score edges down. In 45 days it will be worth half. In 90 days, if
    nothing new arrives, the company falls out of `pending()` entirely and
    stops costing anything.
24. **M8** now counts one management approval, and the spend endpoint reports
    a cost per qualified opportunity of roughly **$0.0012**.

---

## 15. Known gaps — the honest list

These are real and tracked; none of them is hidden.

- **SEC EDGAR produces no companies under the default resolver.** SEC
  publishes no website for a Form D filer, so `SEC_DOMAIN_RESOLVER=none`
  means those signals are counted as filtered out rather than attached to a
  guessed company. That is the *correct* trade: an earlier version attached a
  real funding event to the wrong company 12% of the time. A Clearbit
  autocomplete resolver exists as an alternative.
- **`ingest.ats` only visits companies already marked as tracked.** Slug
  discovery narrows this, but the ATS source itself does not find new
  companies — the HN hiring thread is what does.
- **Product Hunt is untested live** — its token has been a placeholder.
- **A run interrupted by a process restart stays `running` in `job_runs`.**
  Postgres releases the advisory lock so nothing deadlocks, but the row needs
  a sweeper. Until then, a restart mid-run can make n8n's "already running?"
  check skip the next scheduled run.
- **The fit filter scores but does not gate**, and firmographics are never
  populated, so four of its seven inputs are always zero.
- **The committed workflow JSON uses `$env`, the live instance uses `$vars`**
  (see §13). This is the one to fix next: the repo is not safely re-importable
  until all 12 workflows are re-exported from n8n Cloud.

**Fixed on 2026-09-16** (kept here because both were silent failures, which is
the kind worth remembering):

- **The Slack digest posted no leads.** W6's "Map Digest to Slack Blocks" read
  `digest.opportunities[]` with fields `company`, `score`, `whyNow`, `service`
  and `freshestSignalAge` — none of which the backend has ever sent. Nothing
  errored: `digest.opportunities` was `undefined`, the loop ran zero times,
  and Slack got a header block with nothing under it, every weekday. It now
  maps `digest.leads[]` (`companyName`, `totalScore`, `headline` falling back
  to `likelyNeed`, `archetype`, `topEvidenceUrl`) with the real four bands
  instead of the stale `medium` / `low`. Fixed in the export and published
  live (version `9195e3c1`).
- **The empty-state message linked to `{DASHBOARD_URL}/investigate`**, which is
  not a route — the dashboard has `/`, `/leads`, `/leads/:id`,
  `/companies/:id`, `/metrics`, `/funnel`, `/settings/scoring`. Now
  `/leads?band=investigate`, which the Leads screen reads and validates
  against the backend's own band vocabulary.
- **The two repos have no cross-repo contract enforcement** (see §11).

---

## 16. Glossary

| Term | Means |
|---|---|
| **Signal** | One observable fact about one company on one date, with a source URL |
| **Event signal** | S1–S7 — something that *happened* |
| **Standing property** | F-LEG, F-PLAT — something that is simply *true* of the company |
| **Canonical domain** | The company's identity: one normalised domain, unique in the database |
| **Dedupe hash** | The semantic fingerprint of an event — company + type + day + subject — whose uniqueness prevents duplicates |
| **Fit score** | 0–100, firmographic "is this the right kind of organisation?" — contributes at half weight, gates nothing |
| **Trigger gate** | The free keyword check that decides whether a company is worth paying to think about |
| **Evidence strength** | E0–E4, how *directly* a signal asserts a problem or an intent to buy |
| **Band ceiling** | The highest band a given evidence strength permits, whatever the score |
| **Compound bonus** | Up to +10 for several *different kinds* of signal inside 90 days |
| **Archetype** | Which of Rubico's four engagement shapes this opportunity is — and the key that lets one company hold several leads |
| **Half-life** | The number of days after which a signal is worth half as much |
| **Lead** | One scored, classified opportunity at one company |
| **Brief** | The 30-second, fully cited write-up a salesperson reads |
| **Band** | immediate / high / investigate / ignore |
| **Attribution** | Whose judgement a decision was — `management` counts as validation, `builder` does not |
| **Watermark** | Where an ingest job got to last time |
| **Idempotency key** | A per-request token that makes a retry safe to send twice |

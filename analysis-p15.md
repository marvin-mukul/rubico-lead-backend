# Broadening the Lead Engine — gap analysis and phase plan (P15+)

Planning document. No source files, schema, config or tests were modified.
Every claim below is cited to a file or to a query run against the live dev
database on 2026-09-11.

---

## 0. Executive summary — read this first

The brief assumes A1 fails because discovery is too narrow. **Discovery
breadth is the second problem, not the first.**

> **The fit filter currently rejects 100% of companies and structurally cannot
> pass any.** Nothing in the codebase populates `industry`, `country`,
> `region` or `headcountBand`, so every firmographic dimension resolves to its
> `.default` of 0. The maximum achievable `fitScore` is **20**, against
> `fit.minScore = 40`.

Measured, not inferred — the real filter run over the real 14 companies:

```
companies evaluated: 14
passed fit filter  : 0     (threshold fit.minScore = 40)
best score achieved: 15    (wordpress.org)
```

Consequences that reframe the whole session:

1. **A1 would still fail with 10,000 companies.** The gate is the binding
   constraint, not the funnel. Adding sources before fixing it adds rows that
   die at the same place.
2. **The pipeline has never classified anything.** `m4_classified: 0` in the
   live metrics is not "no keys yet" — it is the fit gate. Every downstream
   guarantee (classify, score, brief) is therefore unexercised against real
   data.
3. **The one company that scored highest did so because of the §2.1 defect.**
   `wordpress.org` reached 15 entirely from `fit.signal.legacyStack`, awarded
   for a wrongly-raised `F-LEG`. The best-performing row in the database is an
   artefact of the bug the brief already identified.
4. **The industry-weighting debate is moot until firmographics exist.**
   Industry weights cannot be "too narrow" when the column is always `NULL`.
   The real question is whether to populate industry at all, and §8.1 treats
   it as such.

A second, independent defect compounds it — see §1.7. And a third finding
falsifies the §2.4 hypothesis — see §1.7 and §8.4.

**Recommended first move (P15) is config-only and costs nothing**: make the
existing gate passable and broaden the HN queries. That proves the pipeline
end to end before any architecture changes.

---

## 1. Current-state inventory (§3.1)

### 1.1 Discovery sources and measured yield

Four registered `ingest.*` jobs (`src/sources/sources.module.ts:83-90`).
Aggregated from `job_runs.counts` of succeeded runs:

| Job | Runs | fetched | deduped | filteredOut | Companies created |
|---|---:|---:|---:|---:|---:|
| `ingest.ats` | 4 | 3,220 | 2,467 | 20 | **0** (visits known companies only) |
| `ingest.sec-edgar` | 1 | 654 | 0 | **654** | **0** |
| `ingest.hackernews` | 3 | 17 | 5 | 5 | ~7 |
| `ingest.product-hunt` | 0 | — | — | — | never run (placeholder token) |

Signals actually in the database:

```
ats:greenhouse / S2     681
ats:ashby      / S2      52
hackernews     / S3       7
homepage-fingerprint / F-LEG  2
```

**The critical distinction the brief's ranking needs:** only HN, Product Hunt
and (in principle) SEC *discover companies*. `ingest.ats` iterates
`atsProvider != null AND atsSlug != null`
(`src/sources/ats/ats.source.ts:33-40`) — it produces signal volume for
companies already known, and creates none. 733 of the 742 signals in the
database belong to **5 hand-seeded companies**.

### 1.2 Company creation and canonical domain

`IngestionService.ingestOne` (`src/sources/ingestion.service.ts:44-79`):
resolve canonical domain → count `filteredOut` if unresolvable → upsert by
`canonicalDomain` → skip if suppressed → insert signal.
`resolveCanonicalDomain` (`src/companies/canonical-domain.ts:73-96`) uses
`tldts`, rejects free-mail, aggregators and IPs with a typed reason.

`CompanyRepository.upsertByDomain` (`src/companies/company.repository.ts:32-45`)
writes only `canonicalDomain` and `name` plus whatever non-null extras the
caller passes. **No source passes firmographics.** See §1.9.

### 1.3 `Signal` model and the `SignalType` union

`SIGNAL_TYPES = ['F-LEG','S1','S2','S3','S4','S5']`
(`src/common/domain/index.ts:8`), with `EVENT_SIGNAL_TYPES` excluding `F-LEG`
(line 12).

**How tightly baked in:** less than feared. The union is declared once, and
the literals appear in exactly three kinds of place:

- each source declaring its own `signalTypes` (one literal each)
- `rescore.job.ts` SQL — a regex `^(F-LEG|S[1-5])\.(weight|halfLifeDays)$` and
  an `IN ('S1',…,'S5')` list, twice
- `enrichment.service.ts` — `'F-LEG'` in three places

Adding a type is: one entry in `SIGNAL_TYPES`, two seeded config keys, and two
edits in the rescore SQL. **The rescore SQL is the only place that would
silently do the wrong thing** — a new type absent from its regex contributes
nothing to intent, with no error. Any phase adding a signal type must touch
`rescore.job.ts` and the parity test.

### 1.4 The fit filter — every key, and where it gates

`FitFilterService.evaluate` (`src/companies/fit-filter.service.ts:56-108`).
Four dimensions (`headcount`, `region`, `country`, `industry`) plus two
bonuses, clamped 0–100, `passes = fitScore >= fit.minScore`.

All 26 seeded `fit.*` keys:

```
fit.minScore            40
fit.headcount.default    0   1-10 2   11-50 15   51-200 25   201-500 20   501-1000 10   1000 5
fit.region.default       0   emea 15  namer 20   apac 8
fit.country.default      0   us 10    gb 10      in 8      ae 8
fit.industry.default     0   saas 20  fintech 18 ecommerce 15  healthcare 12  logistics 12
fit.signal.legacyStack  15
fit.signal.atsPresent    5
```

**Where it gates:** `src/pipeline/pipeline-run.job.ts:113-116`, between
enrichment and `classify.classify()` at line 122. This is the zero-cost gate
§2.2 is protecting, and it is the single point that currently rejects
everything.

**Reachable maximum with the data the engine actually has: 20.** Threshold 40.

### 1.5 Scoring

`score()` (`src/scoring/score.ts:70-146`), pure, no Prisma import.
`total = fit × 0.5 + intent × 1.0 + compoundBonus`, clamped 0–100.

The P10 decision — **only the strongest signal of each type counts**
(lines 96-108) — matters more after broadening than before. With 681 `S2`
signals across three companies, summing would let one company's job board
dominate every other input. It also means **evidence strength has no slot in
the current model**: contribution is `weight(type) × decay(age)` and nothing
else. See §4.

FR-SC4 is applied as a band override with a human-readable `bandReason`
(lines 127-140). **That mechanism is the natural home for the evidence
ceiling proposed in §4.3** — it already exists and is already surfaced through
`GET /api/leads/:id`.

### 1.6 LLM classify — schema and prompt

`classificationSchema` (`src/llm/schemas.ts:14-38`):
`has_rubico_opportunity`, `evidence_sufficient`, `likely_need`,
`rubico_service`, `confidence`, `reasoning`, `cited_signal_ids`.

`rubico_service` is a five-value enum:
`legacy-modernisation | platform-acceleration | product-engineering-pod |
data-and-integration | none`.

**None of the four verified archetypes appears**, and
`ai_code_to_production` — the hero offer — has no representation anywhere in
the codebase. `CLASSIFY_SYSTEM_PROMPT` (`src/llm/prompts.ts:88-110`) describes
an ICP of "30-500 employees, existing product under strain", explicitly
listing "pre-product companies with nothing to modernise" as poor fit — which
excludes the AI-built-prototype case that §1.2 calls the hero offer.

### 1.7 Lead creation, banding, and second leads — **hypothesis falsified**

`ScoringService.upsertLead` (`src/scoring/scoring.service.ts:66-92`) finds the
most recent `Lead` for a company and **updates it in place**. `Lead` is
therefore de facto per-company.

Worse, and independent of that:

```ts
// src/pipeline/pipeline-run.job.ts:82
leads: { none: { brief: { not: undefined } } },
```

Prisma strips `undefined` from filters, so `{ not: undefined }` collapses to
`{}` and the clause degrades to `leads: { none: {} }` — **"companies with no
leads at all"**. Verified against the live database:

```
pending() as written          : 10
same as `no leads at all`?    : true (10)
intended `no briefed lead`    : 12
```

Two consequences:

1. **A company that acquires a Lead is never reprocessed**, whatever happens
   afterwards. New signals do not bring it back.
2. **The brief-retry path is dead.** `AnthropicProvider` deliberately returns
   "batch still processing" rather than erroring, on the stated grounds that
   "the next run picks them up" (`anthropic.provider.ts:70-76`). It never
   does. A batch that misses its poll window loses those briefs permanently.

The same bug exists at `src/metrics/metrics.service.ts:107`
(`counts: { not: undefined }`), where it is benign — it includes runs with
null counts, which the loop then skips.

**Where the four concepts live today:**

| Concept | Represented by | Adequate? |
|---|---|---|
| Company — who they are | `Company` | ✅ |
| Signal — what was observed | `Signal` | ✅ |
| **Opportunity — what problem the evidence suggests** | **nothing** | ❌ conflated into `Lead` |
| Lead — is it worth human follow-up | `Lead` | partially — carries both roles |

### 1.8 Dedupe

`dedupeHash = sha256(companyId | type | UTC-day | normalisedSubject)`
(`src/signals/dedupe-hash.ts:47-56`). Source URL, source name, excerpt and raw
payload are deliberately excluded.

**What breaks if signal types multiply:** nothing structurally — the hash is
type-parameterised. The risk is *subject discipline*. ATS uses
`subject: 'hiring ' + title` (`ats.source.ts:84`), so one company re-listing a
role daily yields one signal per day, which is correct. A new source with a
poorly chosen subject (a timestamp, an incrementing id) would defeat dedupe
silently. Any new source needs its subject choice reviewed as part of its
phase.

### 1.9 Enrichment — the fingerprint rule set

`src/enrichment/homepage-fingerprint/fingerprint.ts`.

```
LEGACY (16): aspnet-webforms aspnet jquery-old php-legacy wordpress
             drupal-old angularjs bootstrap-old table-layout document-write
             flash frames old-apache old-iis jsp coldfusion
MODERN  (9): react nextjs vue nuxt svelte angular tailwind vite cdn-modern
```

Confirming and extending §2.1:

- **`wordpress` is in LEGACY.** WordPress is a published Rubico service line.
  Confirmed defect.
- **Magento has no rule at all** — neither 1.x (genuinely EOL, rebuild-worthy)
  nor 2 (Rubico service line). The version-awareness test case the brief names
  is not merely wrong, it is absent.
- **WooCommerce and Shopify are not detected at all.** Two more service lines
  invisible to the engine.
- **Laravel is not detected.** A named Rubico backend capability.
- `php-legacy` *is* correctly version-aware (`php/[45]\.`), and `jquery-old`
  correctly spares jQuery 3. The rule set is not uniformly naive — it is
  inconsistently so, which is harder to spot.

**And the omission that blocks everything:** `EnrichmentResult` declares
`firmographics?: Firmographics` (`enricher.interface.ts:16`) and
`EnrichmentService` merges and writes it (lines 36-38, 56) — but **no enricher
ever returns it**. `HomepageFingerprintEnricher`, `DnsEnricher` and
`GithubEnricher` return only `detectedStack` / `legacyFlags`. The plumbing
exists; nothing fills it. Hence §0.

### 1.10 Metrics M1–M8

`src/metrics/metrics.service.ts:45-73`. M3–M7 are read from summed
`job_runs.counts`; M1/M2 from table counts; M8 from `Decision` aggregates
using `scoreAtDecision` (correct per FR-B3).

Live values: `m1_signalsIngested: 742`, `m2_companiesDiscovered: 14`,
**`m3`–`m7`: 0**. The funnel is measuring a pipeline that has never run past
the fit gate.

### 1.11 The A1–A10 tests, and which assert on industry

Four spec files reference `industry`, 17 occurrences:

| File | Nature |
|---|---|
| `src/companies/fit-filter.spec.ts` | Uses `fit.industry.saas` as the example weight; asserts the outcome flips when a weight changes. **Tests the mechanism, not the ICP.** |
| `src/pipeline/pipeline-run.spec.ts` | Fixtures use `industry: 'SaaS'` to pass, `'Basket Weaving'` to fail. **Would need new fixtures if industry stops gating.** |
| `src/llm/classify/classify.spec.ts` | `industry` appears in prompt-construction assertions only. |
| `src/api/api.spec.ts` | Fixture data only. |

**No test asserts that a particular industry must be in the ICP.** The
industry coupling is in seeded config and fixtures, not in test intent — so
broadening breaks fewer tests than expected. `pipeline-run.spec.ts` is the
only one needing real rework.

### 1.12 Discovery parameters held in config

Only three config-held knobs exist, all in `src/common/config/env.schema.ts`:

| Key | Line | Notes |
|---|---|---|
| `HACKERNEWS_QUERIES` | 97 | 5 comma-separated queries — the one genuinely tunable discovery parameter |
| `SEC_DOMAIN_RESOLVER` | 93 | `none` \| `clearbit` |
| `PRICE_TABLE_PATH` | 85 | The `*_PATH` JSON precedent §2.3 asks to follow |

Everything else is code: the ATS provider set, ATS job-title matching (there
is none — every posting becomes a signal), the fingerprint rules, the
canonical-domain blocklists, and the classify prompt.

---

## 2. What specifically prevents discovery of a non-software-company opportunity (§3.2)

Ranked by how completely each blocks the outcome. The expected list (industry
weighting, ATS set, HN queries, fingerprint conflation) is all present, but
none of it is the top blocker.

| # | Blocker | File | Kind |
|---|---|---|---|
| **1** | **Fit filter is unpassable.** Max reachable score 20 vs `minScore` 40, because no enricher populates firmographics. Blocks *every* company, software or not. | `fit-filter.service.ts` + `pipeline-run.job.ts:113`; root cause `enrichment/*` | **Code** (populate firmographics) **or config** (reweight) |
| **2** | **A company is processed once, ever.** `pending()`'s no-op filter caps each company at one Lead and kills brief retry. | `pipeline-run.job.ts:82` | **Code** (one-line fix) |
| **3** | **Only 3 of 4 sources can discover a company, and 2 of those are dormant.** ATS visits known companies only; SEC yields 0; Product Hunt never ran. Effective discovery = HN alone. | `ats.source.ts:33`, `sec-edgar`, `product-hunt` | **Code** (new/changed sources) |
| **4** | **No ATS slug discovery.** `atsSlug` is read in 8 places and written by nothing — the only writer is the never-populated `EnrichmentResult.atsSlug`. The 5 tracked companies were inserted by hand. | `ats.source.ts`, `enrichment.service.ts:58` | **Code** |
| 5 | **Industry weighting encodes the wrong ICP** — `saas/fintech/ecommerce/healthcare/logistics` against a real client base of NASA, universities, marine manufacturing, packaging, actuarial, nonprofits. Latent today (column is null) but would bite the moment firmographics land. | seeded `scoring_config` | **Config** |
| 6 | **`F-LEG` conflates obsolescence with Rubico platforms** — `wordpress` flagged; Magento/WooCommerce/Shopify/Laravel absent. | `fingerprint.ts` | **Rule** + data remediation |
| 7 | **No archetype taxonomy, and no `ai_code_to_production`.** The classifier cannot name the hero offer. | `llm/schemas.ts`, `llm/prompts.ts` | **Code + config** |
| 8 | **Classify prompt excludes the hero offer's own audience** — "pre-product companies with nothing to modernise" is listed as poor fit. | `prompts.ts:104` | **Config/prompt** |
| 9 | **HN queries are modernisation-flavoured only** — `legacy system`, `technical debt`, `migrating off`, `rewrite our`. No procurement, RFP, replatform, digitisation or AI-prototype language. | `HACKERNEWS_QUERIES` | **Config** |
| 10 | **ATS providers skew technology-startup** (Greenhouse/Lever/Ashby) and every posting becomes a signal with no title relevance filter. | `ats.providers.ts`, `ats.source.ts:78` | **Code** |
| 11 | **No evidence-strength concept.** A WordPress detection and a published RFP are indistinguishable to the scorer. | `scoring/score.ts` | **Code** |
| 12 | **`Decision.reasonCode` cannot express archetype error** — no way to record "right company, wrong archetype" or "no real technology need". No ground truth to tune against. | `common/domain/index.ts:35` | **Code** (A13) |

Blockers 1 and 2 are ~15 lines between them and gate everything else.

---

## 3. Gap analysis against the verified research (§3.3)

### 3.1 Capability map

| Verified capability (§1.3) | In the engine? |
|---|---|
| PHP / Laravel | Laravel undetected; PHP only as a *legacy* marker |
| WordPress / WooCommerce | WordPress detected **as a defect**; WooCommerce absent |
| Shopify / Magento | Both absent entirely |
| Angular (current) | Detected as modern ✅; AngularJS 1.x as legacy ✅ |
| React / Next / Vue / Node | Detected ✅ — the one well-served area |
| Mobile: Flutter, Swift, Kotlin, React Native | **No detection of any kind** |
| Cloud / DevOps / Testing stacks | Not represented |
| Segments: Agencies, Enterprises, Nonprofits, Startups | Not represented |

`requirement.md`'s fit criterion "stack overlaps Rubico capability
(React/Node/Next)" describes perhaps a quarter of the real capability map, and
the quarter least represented among the published client logos.

### 3.2 Archetypes

No archetype concept exists. `rubico_service`'s five values partially overlap
`fix_slowing_software` and `complex_engineering`, miss `idea_to_product`
entirely, and miss `ai_code_to_production` entirely. The six
production-readiness sub-types (§1.4) have no representation.

### 3.3 Industry

Currently a weighted fit dimension (positive weight, contributes to a hard
threshold). The research says contextual. **Today it is neither** — it is a
null column feeding a zero. The decision in §8.1 is therefore not "reweight or
remove" but "populate as context, or do not populate at all".

### 3.4 `requirement.md` amendments needed

Where research and spec conflict, research wins:

1. **§5 `Signal.type` comment** — `F-LEG | S1..S5` must admit `F-PLAT` and the
   new signal types from §5 of this document.
2. **§11 / FR-AI5** — add the archetype taxonomy; `rubico_service` becomes
   `archetype` + `rubico_capabilities[]`.
3. **Fit criterion "stack overlaps React/Node/Next"** — replace with the full
   capability map, held in JSON per §2.3.
4. **§3 module layout** — add `opportunity/` (trigger + evidence strength) and
   `capability/` (capability map).
5. **§13 A1** — replace with A1′ (§6).
6. **§12 test list** — add evidence-strength, trigger-gate and platform-is-not-
   a-defect tests.
7. **§10** — new `*_PATH` env vars for the JSON config files.
8. **Add the ICP correction explicitly**: the published client base is
   dominated by non-software organisations, and the spec's ICP contradicts it.

---

## 4. Evidence-strength model (§3.4)

### 4.1 Two axes, not one

The brief's four-row table mixes two independent questions, and separating
them is the main design contribution here.

- **Evidence strength** — how directly does this evidence assert a technology
  problem or intent?
- **Attribution confidence** — how sure are we the evidence is about *this*
  company?

They must be separate because the SEC failure is purely attributional: a Form
D is respectable evidence of a funding event, attached to the wrong company
12% of the time. Folding attribution into strength would either discard good
evidence or launder a wrong domain into a high score. The `clearbit` resolver
measured one wrong match in five (§P8a) — that is an attribution defect, and a
single axis cannot express it.

### 4.2 The strength ladder

Five levels. `E0` is deliberately not "weak evidence" — it is *not evidence of
an opportunity at all*, which is what §2.5.1/2/3/5 require.

| Level | Name | Asserts | Examples |
|---|---|---|---|
| **E0** | **Context** | What they run or who they are. **Never an opportunity.** | WordPress detected, ATS present, headcount band, industry, funding round, revenue growth, "opened a second location" |
| **E1** | **Inferred initiative** | Someone is doing something that *implies* a project | Hiring "Head of Ecommerce", "Digital Transformation Manager", "Salesforce Administrator"; a burst of IT hiring |
| **E2** | **Stated initiative** | The organisation says it is doing the thing | Press release "we are replatforming"; careers page describing a migration; changelog; conference talk |
| **E3** | **Declared requirement** | The organisation says it needs a supplier | RFP, tender, procurement notice, "seeking an agency", HN "Seeking freelancer" |
| **E4** | **Direct inbound** | They contacted us | First-party form fill (`S5`) |

Note where §2.5.2's examples land: funding, growth and expansion are **E0**.
They can raise a real opportunity's rank; they cannot create one. That is the
principle made mechanical.

Attribution confidence is a separate small enum — `A_exact` (domain came from
the source itself), `A_matched` (name→domain resolution), `A_weak` (heuristic)
— stored per signal. SEC under `clearbit` is `A_matched`; ATS and HN are
`A_exact`.

### 4.3 How strength enters the score — recommendation

Three options were considered.

| Option | Mechanism | Problem |
|---|---|---|
| (a) Per-signal multiplier | `contribution × strengthFactor` | Enough E0 signals still sum into a high band. Violates §2.5.3. |
| (b) Separate score dimension | `evidenceScore` alongside fit/intent | Another weighted addend — same failure as (a), plus a new dimension to explain. |
| **(c) Band ceiling + bounded multiplier** | Strength caps the reachable band; a small multiplier ranks within it | A misclassified strength silently caps a real lead |

**Recommend (c).** §2.5.3 is structurally a gate — "contextual evidence cannot
*create* an opportunity" is a statement about reachability, not about weight —
so it should be implemented as a gate:

```
maxBandFor(strongest evidence on the company):
  E0 → ignore        E1 → investigate       E2 → high
  E3 → immediate     E4 → immediate
```

plus a bounded per-signal multiplier (`E0 0.25 · E1 1.0 · E2 1.5 · E3 2.0 ·
E4 2.0`) so ordering within a band reflects evidence quality. Weights live in
`scoring_config` (`evidence.E2.multiplier`), so FR-SC3 still holds.

**Why this fits the existing code rather than fighting it:** FR-SC4 already
implements exactly this shape — a band override carrying a human-readable
`bandReason` (`score.ts:127-140`), already surfaced through
`GET /api/leads/:id`. The ceiling reuses that mechanism, so explainability
(FR-B16) comes for free: *"capped at investigate — strongest evidence is an
inferred initiative (job posting), signal sig_123."*

**The tradeoff, stated plainly:** a hard ceiling means one mis-tagged signal
can suppress a genuine lead, and unlike a weight it cannot be compensated for
by other evidence. Three mitigations: the cap is always visible in
`bandReason`; the A13 reason codes give a human a way to report it; and
strength is assigned by deterministic rules in JSON config, so a wrong tag is
a config fix, not a redeploy.

---

## 5. Discovery prioritisation (§3.5)

### 5.1 The ranking criterion the brief's list needs

**Distinguish company-discovering sources from signal-enriching sources.**
A1′ counts companies. `ingest.ats` has produced 3,220 fetches and **zero
companies**. Ranking by volume puts it first; ranking by what A1′ measures
puts it well down.

### 5.2 Evaluation

Yield estimates are order-of-magnitude and stated as assumptions to be
measured, not as findings.

| Source | New cos/mo | Strength | Fresh | FP risk | Effort | Legal | Cost |
|---|---:|---|---|---|---|---|---|
| **HN query broadening** | 30–150 | E1–E3 | hours | med | **config only** | fine | $0 |
| **Fit-gate fix** (not a source) | — | — | — | — | config | — | $0 |
| **UK Contracts Finder** | 100–400 | **E3** | daily | **low** | medium | **OGL, verified 200** | $0 |
| **Press-release RSS** | 50–200 | E2 | hours | med | medium | verify ToS | $0 |
| **ATS slug discovery** | **0 new** | E1 | daily | low | medium | fine | $0 |
| **Workable/SmartRecruiters/Recruitee** | 0 new | E1 | daily | low | **low** | fine | $0 |
| **ATS title patterns** | 0 new | E1 | — | low | config* | fine | $0 |
| **Product Hunt** | 20–60 | E0–E1 | daily | med | done | token | $0 |
| **sec-edgar** | ~0 | E0 | daily | **high** | done | fine | $0 |

\* config-only once the JSON trigger infrastructure from P18 exists.

### 5.3 Procurement — verified, and it carries the same attribution trap

I checked availability rather than assuming it (2026-09-11):

```
UK Contracts Finder OCDS Search   HTTP 200   ✅ open, no key
PRNewswire RSS                    HTTP 200   ✅
BusinessWire RSS                  HTTP 200   ✅
TED (EU) v3 search                HTTP 400   endpoint live, payload shape needs work
SAM.gov opportunities v2          HTTP 404   needs a key / different path
```

A live Contracts Finder release:

```
buyer      : Princess Alexandra Hospital NHS Trust
title      : PAHT - Kingsmoore Ward Refurbishment works
classifier : Refurbishment work
value      : 92295.28 GBP
buyer uri  : GB-CFS-338240
```

Two things follow, one good and one cautionary:

- **Good:** the CPV `classification` field makes the opportunity trigger a
  *code lookup* for this source — CPV `72000000-5` (IT services) and
  `48000000-8` (software packages) are a deterministic, high-precision,
  zero-cost filter. No text matching needed.
- **Cautionary: there is no buyer domain.** The buyer is a name and an
  internal id — **the same attribution problem that makes `sec-edgar`
  useless.** The difference is tractability: "Princess Alexandra Hospital NHS
  Trust" is a real named institution that resolves reliably, where "AIRES126 a
  Series of CGF2021 LLC" does not. But procurement must not be adopted without
  deciding the name→domain question (§8.2), or it will reproduce the SEC
  failure with better-sounding inputs.

### 5.4 Recommended order

**Config-only first, as asked — two of them, and they are free:**

1. **P15 — fit-gate reweight + HN query broadening.** Pure `scoring_config`
   and `.env`. Unblocks the entire pipeline and roughly triples HN discovery.
2. **P22 — ATS title patterns** (config, once P18's JSON infrastructure
   exists).

Then, in dependency order: the two defect fixes → the platform/legacy split →
JSON config → trigger gate → evidence strength → per-opportunity leads →
classifier v2 → then sources, ranked: Contracts Finder → press RSS →
ATS discovery + new providers → Product Hunt.

### 5.5 `sec-edgar` — agreed, with one qualification

**Agree with deprioritising.** 654 fetched, 0 companies, ~12% resolution with
a measured wrong match, and a wrong domain silently merges two real companies
with no downstream way to notice — it fails §2.5 on evidence quality before it
fails on yield.

The qualification: **do not delete it.** It is the only working example of the
`SignalSource` seam handling a paginated, watermarked, rate-limited upstream,
and the correctness guard it grew (all-days-missing ⇒ fail rather than report
a silent zero) is a pattern the procurement source will need. Leave it
registered and unscheduled. If the §8.2 domain-resolution decision produces a
reliable resolver, SEC becomes valuable again for free.

---

## 6. Proposed acceptance criteria (§3.6)

### 6.1 A1′ — two problems with the proposed wording

> *Proposed:* ≥100 companies with ≥1 dated signal, from ≥3 distinct sources,
> spanning ≥5 distinct `industry` values, of which ≥40 are not software/IT.

1. **`industry` is `NULL` for 100% of companies and nothing populates it.** As
   written, A1′ is unsatisfiable regardless of discovery breadth. It either
   requires an industry-population phase as a dependency, or must measure
   breadth another way.
2. **"not classifiable as software/IT" has no field to evaluate against** for
   the same reason.

Two ways out. **Recommended:** keep industry in A1′ and accept the dependency,
because industry is genuinely useful as *context* for the classifier even
though it must not gate (§2.5.4) — but make the phase explicit rather than
implicit. The alternative, measuring breadth by source diversity and signal
type alone, is cheaper but proves less.

**Revised A1′, SQL-checkable:**

```sql
-- every clause must hold
WITH c AS (
  SELECT co.id, co.industry,
         count(DISTINCT s."sourceName") AS srcs
  FROM "Company" co JOIN "Signal" s ON s."companyId" = co.id
  WHERE co."suppressionReason" IS NULL
  GROUP BY co.id, co.industry
)
SELECT
  count(*)                                              AS companies,          -- ≥ 100
  count(*) FILTER (WHERE industry IS NOT NULL)          AS with_industry,      -- ≥ 100
  count(DISTINCT industry)                              AS industries,         -- ≥ 5
  count(*) FILTER (WHERE industry NOT IN
      ('software','it-services','saas'))                AS non_software,       -- ≥ 40
  (SELECT count(DISTINCT "sourceName") FROM "Signal")   AS sources             -- ≥ 3
FROM c;
```

**Plus a quality floor A1′ must not be met without** — this is the teeth
behind §2.5.9/10:

> **A1′-quality** — of those ≥100 companies, ≥30 must carry at least one
> signal at evidence strength **E2 or higher**. Breadth achieved entirely from
> E0/E1 evidence does not satisfy A1′.

Without that clause, A1′ is satisfiable by pointing a scraper at any company
directory, which is exactly the failure mode §2.5 exists to prevent.

### 6.2 A11 — cost containment

> *Proposed:* cost per classified company must not exceed the P14 baseline.

**There is no P14 baseline** — `m4_classified = 0` and `api_usage` is empty.
The criterion needs a definition rather than a comparison.

From the real price table (`config/pricing.json`, gemini-2.5-flash-lite):

```
classify, cold system prompt : $0.000290
classify, cached system      : $0.000200     ← steady state (FR-AI4)
calls affordable in $25 cap  : 125,000 / month
1,000 extra false positives/day × 30 days: $6.00
```

**Revised A11:** mean cost per classified company ≤ **$0.0005** (2.5× the warm
classify cost, leaving room for retries and cold cache), measured over ≥500
classifications, with total MTD spend ≤ 60% of `MONTHLY_CAP_USD`.

### 6.3 A12 — platform is not a defect

Accept as written. SQL-checkable:

```sql
SELECT count(*) FROM "Signal" s JOIN "Company" c ON c.id = s."companyId"
WHERE s.type = 'F-LEG'
  AND (c."detectedStack" ? 'wordpress' OR c."detectedStack" ? 'woocommerce'
    OR c."detectedStack" ? 'shopify'   OR c."detectedStack" ? 'magento2');
-- must be 0
```

Note this must hold **after** the remediation of existing rows, not only for
new ones.

### 6.4 A13 — calibratable classification

The current enum cannot express the two failures that matter most after
broadening. Proposed additions:

| New code | Means | Tunes |
|---|---|---|
| `wrong_archetype` | Right company and real need, wrong archetype | Archetype taxonomy, classify prompt |
| `no_technology_need` | Real company event, but no technology problem — §2.5.2's failure | Trigger rules |
| `evidence_too_weak` | Plausible, but evidence does not support contacting them | Evidence-strength thresholds |
| `wrong_capability` | Right archetype, capability Rubico does not offer | Capability map |
| `platform_not_problem` | Pitched a rebuild of something that is fine — §2.1's failure | Fingerprint rules |
| `attribution_error` | Evidence belongs to a different company | Domain resolution (§8.2) |

Keep all six existing codes. `wrong_fit` and `no_real_need` become
deliberately coarse fallbacks.

**A13 is satisfied when** each code is queryable joined to the lead's
archetype and its triggering signal types, so "which trigger family produces
the most `no_technology_need`?" is one query. Without that join, the trigger
rules and evidence weights have no ground truth — this is the highest-value
criterion on the list and the cheapest to build.

### 6.5 Two more I propose

> **A14 — attribution honesty.** Every `Company` whose canonical domain came
> from name→domain resolution carries the resolver name and a confidence
> level, and no lead reaches band `immediate` on `A_weak` attribution alone.
> Directly prevents the SEC failure recurring through procurement.

> **A15 — a company can hold concurrent opportunities.** A company with two
> distinct opportunities produces two rows a human can decide on separately,
> and deciding one does not alter the other. Tests §1.7's fix.

---

## 7. Proposed phase plan (P15+) (§3.7)

Each phase: one focused session, explicit **Changes** and **Preserves**.

### P15 — Unblock the gate *(config only, no code)*
**Spec refs:** §6.2 of this doc, FR-SC3 · **Depends:** nothing
- Reweight `scoring_config` so the fit gate is passable with the data that
  actually exists: either lower `fit.minScore` to ~15 or raise
  `fit.signal.*`. Deliberately a stopgap — P19 replaces the gate.
- Broaden `HACKERNEWS_QUERIES` toward procurement, replatform, digitisation
  and AI-prototype language.
- **Changes:** the fit gate stops rejecting 100% of companies.
- **Preserves:** every guarantee — nothing but seeded numbers and one env var
  changes.
- **Done when:** ≥1 company passes the fit filter; a live `pipeline.run`
  reaches `classified > 0`; no file outside `scoring_config` and `.env`
  changed.

### P16 — The two no-op filter defects
**Spec refs:** FR-B9 · **Depends:** P15
- Fix `pipeline-run.job.ts:82` to mean "no *briefed* lead", and
  `metrics.service.ts:107`.
- **Changes:** companies become reprocessable; brief retry starts working.
- **Preserves:** batch semantics, counts, idempotency.
- **Done when:** a company with an unbriefed lead is returned by `pending()`;
  a regression test pins the filter semantics against Prisma's `undefined`
  stripping.

### P17 — `F-LEG` / `F-PLAT` split + data remediation
**Spec refs:** §2.1, A12 · **Depends:** P16
- New `F-PLAT` signal type. Move `wordpress` out of legacy; add WooCommerce,
  Shopify, Magento **2** (platform) and Magento **1.x**, Drupal 7 (legacy);
  add Laravel detection.
- Remediate existing wrong `F-LEG` rows and rescore affected leads.
- **Changes:** platform detection stops producing modernisation pitches.
- **Preserves:** dedupe, F-LEG's exclusion from compound detection, the
  rescore parity test (**must be updated — the SQL regex in
  `rescore.job.ts` will silently ignore `F-PLAT` otherwise**).
- **Done when:** A12's query returns 0, including for pre-existing rows.

### P18 — JSON config infrastructure
**Spec refs:** §2.3, FR-C9 precedent · **Depends:** P17
- `CAPABILITY_MAP_PATH`, `ARCHETYPE_PATH`, `TRIGGER_PATH`,
  `EVIDENCE_PATH` — Zod-validated at boot, fail-fast, exactly like
  `PRICE_TABLE_PATH`.
- **Changes:** structure moves out of code. **Preserves:** numeric weights stay
  PATCHable in `scoring_config` (FR-SC3).

### P19 — Opportunity trigger gate
**Spec refs:** §2.2 · **Depends:** P18
- Deterministic, zero-cost trigger matching signal text and (for procurement)
  CPV codes against capability families; emits candidate archetypes.
- **Demote the fit filter from gate to contextual scorer.** It asks "is this
  the right kind of company?", which §2.5.4 says must not be a hard exclusion;
  no reweighting turns it into "is there evidence of a technology problem?".
- **Tuned for recall** per §2.2 — the arithmetic in §6.2 says 1,000 extra
  false positives a day costs $6/month against a $25 cap, so the gate should
  admit on any family match and be tightened only if MTD spend passes ~40%.
- **Changes:** what gates the LLM. **Preserves:** a deterministic zero-cost
  gate remains between persistence and the first billable call.
- **Done when:** no company reaches classify without a trigger match; A11
  holds; a fixture of known-good non-software opportunities passes the gate.

### P20 — Evidence strength + band ceiling
**Spec refs:** §4 above, FR-B16, FR-SC4 · **Depends:** P19
- Per-signal strength and attribution tags; band ceiling via the existing
  `bandReason` mechanism; bounded multipliers in `scoring_config`.
- **Changes:** banding gains a ceiling. **Preserves:** pure scoring functions,
  the P10 strongest-per-type rule, and **the TS/SQL rescore parity test, which
  must be extended to the ceiling**.

### P21 — `Lead` becomes per-opportunity
**Spec refs:** §2.4, A15 · **Depends:** P20 · **See §8.4**
- Add `Lead.opportunityKey` + `@@unique([companyId, opportunityKey])`. One
  migration, **no new table**.
- **Changes:** a company may hold several concurrent leads.
- **Preserves:** `Decision` FK, scoring, digest, banding.

### P22 — Classifier v2 *(archetypes + why-this-lead)*
**Spec refs:** §1.2, §2.5.7, FR-AI2/5/6 · **Depends:** P21
- `archetype` + `rubico_capabilities[]` replacing `rubico_service`; the
  structured why-this-lead chain; prompt rewritten against the verified ICP,
  **including the AI-prototype audience the current prompt excludes**.
- **Preserves:** FR-AI5 refusals, FR-AI6 citation enforcement (extended to the
  chain), prompt-cache stability.

### P23 — A13 decision reason codes
**Depends:** P22 · Cheap, and everything after it is untunable without it.

### P24–P27 — Discovery, in ranked order
UK Contracts Finder (P24) → press-release RSS (P25) → ATS slug discovery +
Workable/SmartRecruiters/Recruitee (P26) → Product Hunt activation (P27).
Each **preserves** dedupe, canonicalisation and the trigger gate, and each must
have its `subject` choice reviewed per §1.8.

### P28 — A1′ / A11 / A12 / A14 verification sweep

---

## 8. Open decisions — yours, not mine (§3.8)

### 8.1 Industry: populate as context, or drop entirely?
The column is always `NULL`, so "reweight" is not one of the real options.
- **(a) Populate as context, never gating** *(recommended)* — infer from
  homepage/DNS/CPV; feed the classifier and A1′; remove all `fit.industry.*`
  weights. Honours §2.5.4 and makes A1′ measurable.
- (b) Drop industry entirely — cheaper, but A1′ loses its breadth measure and
  the classifier loses genuinely useful context.
- (c) Keep as a weight — contradicts §2.5.4 and the client-base evidence.

### 8.2 Name → domain resolution (SEC, and now procurement)
This decision is larger than SEC: **every strong-evidence source identifies
organisations by name, not domain.**
- **(a) Resolve with an explicit confidence tag and cap the band**
  *(recommended, via A14)* — unlocks procurement without laundering wrong
  matches.
- (b) Keep `none` — procurement becomes near-useless, as SEC is.
- (c) Resolve freely — reintroduces the silent company-merge, violating §2.5.

### 8.3 How far toward recall to tune the trigger gate
- **(a) Very loose** *(recommended)* — admit on any capability-family match.
  $6/month per 1,000 daily false positives against a $25 cap; false negatives
  are invisible and unrecoverable.
- (b) Moderate — require two families or one strong family.
- (c) Tight — precision at the gate; contradicts §2.2's asymmetry argument.

### 8.4 Does `Lead` become per-opportunity?
**The §2.4 hypothesis is falsified** — but not in the direction of needing a
new table.
- **(a) `Lead.opportunityKey` + composite unique** *(recommended)* — one
  migration, no new table, `Decision` FK untouched. Smallest change that
  represents the concept correctly rather than merely fitting it.
- (b) Opportunities inside `llmClassification` JSON — no migration, but `band`,
  `status` and `Decision` are per-`Lead`, so a company with three opportunities
  at three bands cannot be represented, and a human cannot decide on them
  separately.
- (c) A new `Opportunity` table — cleanest conceptually; a larger migration and
  a rewrite of scoring, digest and the `/api/leads` surface. Hard to justify
  against (a).

### 8.5 How evidence strength enters the score
Recommendation and tradeoff in §4.3: **band ceiling plus bounded multiplier**.
The alternative worth your attention is multiplier-only, which cannot express
"context never creates an opportunity" and so weakens §2.5.3 to a preference.

### 8.6 Is the P15 stopgap acceptable?
P15 makes the *wrong* gate passable so the pipeline can run end to end before
P19 replaces it. The alternative is leaving the pipeline unexercised for
several more phases. **Recommend taking the stopgap** — it is config-only,
reversible, and the risk it carries is that a loose fit gate briefly admits
low-quality companies to classify, which costs $0.0002 each.

---

## 9. Anti-drift check (against `implementation.md` §4)

Nothing proposed here installs `@nestjs/schedule`, enables CORS, adds Redis,
a queue, Docker-in-prod or a job dashboard; adds a paid provider; builds an
outreach implementation; bypasses `MeteredClient`; moves scoring arithmetic
out of `scoring/`; weakens FR-C5; removes dedupe or canonicalisation; or reads
`process.env` outside `common/config`.

Three proposals deserve explicit scrutiny against it:

- **P19 removes the fit filter as the gate.** It does not remove the gate. A
  deterministic zero-cost check remains between persistence and the first
  billable call, as §2.2 requires.
- **P17 and P21 both touch persisted data.** P17 is a data fix, P21 a
  migration; both must be reversible and neither may drop a signal.
- **The trigger layer must not become an industry rule engine.** It matches
  *capability-relevant language and codes*, never industry. If a trigger rule
  ever reads a company's industry, it has drifted.

---

## 10. What I need from you before building

1. §8.1 industry, §8.2 name→domain, §8.3 gate looseness, §8.4 `Lead` shape,
   §8.5 scoring mechanism, §8.6 the stopgap.
2. Confirmation that **P15 and P16 can proceed immediately** — they are ~15
   lines and one config change between them, they fix defects rather than add
   features, and every later phase is measured against a pipeline that
   currently cannot run.
3. The two API keys, so A6 can close and P22's prompt work can be evaluated
   against a real model rather than a schema.

# TASK: Analyse and plan the broadening of the Lead Engine. This is a planning session.

## 0. Your situation

Read `implementation.md` and `requirement.md` in this repo before anything else.

You have completed P0–P14 of `rubico-lead-engine-api`. Two acceptance criteria are open:

- **A1 fails.** 14 companies carry signals against a target of 100. `sec-edgar` yields 0 companies under the default domain resolver because SEC publishes no filer website. `ingest.ats` only visits companies already flagged as tracked, and nothing discovers ATS slugs.
- **A6 is partial.** Both LLM keys are still `REPLACE_ME`; no real model call has been made.

The strategic problem behind A1 is not a bug. The engine was specified around software companies hiring engineers, and **that is too narrow a representation of Rubico's target market.** Software companies remain entirely valid customers — they are simply not the only ones, and they are not the majority of Rubico's actual client base (§1.6). You are widening the funnel, not replacing it.

Your job this session: a gap analysis and a proposed phase plan (P15 onward) that broadens discovery and qualification from "software companies" to "any organisation with credible evidence of a technology problem Rubico can solve" — without weakening the cost, dedupe, explainability or metering guarantees P0–P14 established, and without turning generic business news into leads.

---

## 1. Verified research on Rubico's actual capabilities

Gathered by fetching `rubicotech.com` and `rubicotech.in` in September 2026. Treat as fact; do not re-derive. If you have web access you may verify and extend from `https://rubicotech.com/ai-solutions/` and the four `/specialities/*` pages, which were not fetched.

### 1.1 The two sites serve different purposes

- **`rubicotech.com` is the services/sales site.** Its homepage is now positioned entirely around **making AI-built applications production-ready**: "Built it in Lovable, Replit, Bolt, or Claude? Rubico's engineers secure, finish, and make it ready to be shipped."
- **`rubicotech.in` is a recruitment site** for developers in Uttarakhand (`talent@RubicoTech.in`, "See Open Roles"). It is **not** a source of truth for what Rubico sells. It *is* reliable for the delivery technology stack.

Do not mine the `.in` site for service lines.

### 1.2 The four engagement archetypes — the classifier's top-level taxonomy

Verbatim from the Software Factory page ("The Factory has a job to do"):

| Archetype | Rubico's own framing |
|---|---|
| `idea_to_product` | "starting with an idea" — idea to product |
| `ai_code_to_production` | AI-generated code to production-ready — **the hero offer** |
| `fix_slowing_software` | "fixing software that's already running", software slowing down |
| `complex_engineering` | complex engineering problems, capacity, expertise |

Four explainable buckets mapping to real sales motions. Prefer these over a flat list of 24 capabilities; finer capabilities become a `rubico_capabilities[]` array attached to an archetype.

### 1.3 Verified technology capability map

From `rubicotech.in/technologies`. Note what is present that `requirement.md` omits.

```
Frontend:  Angular, React, Vue.js, Next.js, HTMX, Bootstrap, CSS, HTML,
           Foundation, Materialize
Backend:   Node.js, Express.js, Nest.js, Django, Python, Laravel, PHP
eCommerce: WordPress, WooCommerce, Shopify, Magento Commerce (Adobe Commerce)
Databases: MongoDB, MySQL, PostgreSQL, Firebase
Mobile:    React Native, Android, iOS, Swift, Kotlin, Flutter, Ionic, Xcode
Cloud:     AWS, GCP, Azure, DigitalOcean, Heroku
DevOps:    Docker, Terraform, Ansible, Jenkins, GitHub Actions, Git,
           Prometheus, Grafana, Datadog, New Relic, Site24x7, CloudFormation
Testing:   Postman, Swagger, Selenium, Cypress, JMeter, BlazeMeter
```

Service lines (`.com` footer): AI Solutions, Custom Software Development, Web App Development, Mobile App Development, Website Development, Go-To-Market / Digital Marketing. Plus QA and UX/UI as named disciplines.

Rubico's own segment framing: **Agencies, Enterprises, Nonprofits, Startups.**

### 1.4 The six production-readiness problem areas

Published as the specific gaps in AI-generated code — ready-made opportunity sub-types under `ai_code_to_production`:

`production_readiness`, `data_security`, `user_access_management`, `scaling_performance`, `integrations_dependencies`, `hidden_technical_blockers`

### 1.5 The offer ladder changes what "qualified" means

| Tier | Price | Content |
|---|---|---|
| Consultation | free | 30 min with an Engagement Architect |
| **Technical Expert engagement** | **$500** | 48 hours with a technical expert + team, 45-min kickoff, private Slack, refund if not a fit |
| Custom | quote | Custom engagements, staff augmentation |

The entry offer is $500, not $50,000. See the constraint in §2.5.6 — this has direct consequences for scoring.

### 1.6 Rubico's real client base contradicts the current ICP

Published logos: **NASA, University of Michigan, Boston Whaler** (marine manufacturing), **Genpak** (packaging), **Springfree** (consumer products), **Milliman** (actuarial/insurance), **Cru** and **New Horizon Foundation** (nonprofits), **DaySpring** (publishing), **Salimetrics** (life sciences), **ACSI** (education), **E-Halpass** (transport/government), Workhouse, Tunescribers, 1010Discs. 800+ clients since 2003, 2000+ projects, 100+ technologists, US and India delivery.

Almost none are software companies. **The industry-weighted fit filter is currently filtering out Rubico's actual customer base.** This is the empirical case for broadening, and it is stronger than any argument in the strategy document.

---

## 2. Findings and hypotheses

§2.1 is a confirmed defect. §2.2 states a constraint plus a proposed mechanism. §2.3 is a settled technical fact. §2.4 is a **hypothesis to test**, not a conclusion. §2.5 is non-negotiable strategic intent.

### 2.1 P9's `F-LEG` rules are actively mis-scoring — confirmed defect

Your P9 notes record flagging `wordpress.org` as legacy and raising an `F-LEG` signal. But **WordPress, WooCommerce, Shopify and Magento are published Rubico service lines** (§1.3). A WordPress site is not a company needing a rebuild pitch; it is a company on a platform Rubico staffs for.

Split the marker classes:

- **`F-LEG` — rebuild-worthy obsolescence.** AngularJS 1.x, jQuery 1.x/2.x, ASP.NET WebForms, PHP 5.x, **Magento 1.x** (EOL June 2020), Drupal 7, Flash remnants, unsupported framework majors. Supports a modernisation pitch.
- **`F-PLAT` — Rubico-serviced platform.** WordPress, WooCommerce, Shopify, Magento 2, Laravel, current Angular. A **capability-match and opportunity input, never a defect.**

Magento landing in both classes by major version is the test case proving these rules need version awareness, not presence detection.

**Generalise this.** The principle is broader than Magento: see §2.5.5. React detected does not mean a React migration is needed; WordPress detected does not mean a rebuild is needed.

**Include a data-remediation step in your plan.** Existing `F-LEG` rows raised against Rubico-serviced platforms are wrong and already in the database, and the Leads scored from them are wrong too. This is a data fix, not a migration.

### 2.2 The gate before the LLM — a constraint, and a proposed mechanism

P12 records: "A company failing the fit filter is dropped **before any LLM call**." That gate is the cost control. If industry stops being a hard filter, **nothing gates the classifier** and cost scales with a much broader funnel.

**The constraint is non-negotiable:** a deterministic, zero-cost gate must remain between signal persistence and the first billable call. Broadening must not be achieved by letting more candidates reach the LLM.

**The mechanism is my proposal, not a decision.** An **opportunity trigger** stage that pattern-matches signal text (job titles and descriptions, HN post text, press-release text, changelog entries) against capability-relevant families and emits candidate archetypes with no LLM call. Companies whose signals produce zero trigger matches never reach classify.

Evaluate this against the code. If inspection shows a better deterministic gate — reusing the fit filter with reweighted inputs, a signal-type-plus-evidence-strength rule, something else — propose it and say why it beats a trigger layer. What I require is *a* free gate, not this specific one.

**Tune the gate for recall, not precision.** The cost of error is asymmetric and points against instinct:

- A trigger **false negative** silently drops a real opportunity. It is invisible, unmeasurable, and unrecoverable — nothing downstream can rescue a signal the gate discarded.
- A trigger **false positive** costs one classify call, roughly $0.0002 at current rates.

Precision belongs at the classifier, which is already required to be able to say no cheaply (FR-AI5). Do not tune the gate tight to save money; the money is not the scarce thing at this stage and the missed leads are. Quantify this tradeoff in your analysis with real numbers from your own cost model.

### 2.3 The capability map cannot live in `scoring_config`

P6 already hit this: `scoring_config.value` is a `Float`, so list-shaped rules need one key per value (`fit.region.emea = 15`). The capability map, archetype taxonomy, evidence-strength model and opportunity triggers are list- and tree-shaped.

**Use JSON config files with `*_PATH` env vars**, following the `PRICE_TABLE_PATH` / `config/pricing.json` precedent from P0. Numeric weights stay in `scoring_config` where a human can PATCH them (FR-SC3). Structure goes in JSON.

### 2.4 Database changes — hypothesis, not conclusion

**Current hypothesis: no new tables should be required for Phase 0.** `Lead` already carries `llmClassification Json`, `likelyNeed` and `rubicoService`; the structured opportunity could live in `llmClassification` with the archetype denormalised into `rubicoService`.

**Verify this against the actual schema and flows. If the code demonstrates a table is necessary, explain why before proposing one. Prefer zero migrations only if the existing model represents the requirement correctly — not merely if it can be made to fit.**

One specific thing to inspect, which may falsify the hypothesis: **a company can have several distinct opportunities over time.**

```
Acme  ├── Jan 2026 → website rebuild
      ├── Apr 2026 → mobile app
      └── Sep 2026 → AI automation
```

These are one Company, many Signals, many Opportunities over time — not three Acmes. But P12 processes only companies "that have no brief yet", which appears to cap a company at one Lead permanently. Determine what the code actually does, whether `Lead` is currently per-company or per-opportunity, and what the smallest correct change is. Report the finding even if it contradicts the hypothesis above.

Keep these four concepts distinct and say where each lives in the schema today:

**Company** — who they are · **Signal** — what was observed · **Opportunity** — what technology problem the evidence suggests · **Lead** — whether it is commercially strong enough for human follow-up.

### 2.5 Opportunity-quality principles — non-negotiable

The failure mode of this work is not staying too narrow. It is broadening until everything is a lead. These ten principles exist to prevent that, and they override any local optimisation.

1. **A company is not an opportunity.** Discovering an organisation is not discovering a reason to contact it.
2. **A company-change signal is not automatically a technology opportunity.** "Restaurant opens second location." "Manufacturer's revenue up 30%." "Company raised a round." None of these is a technology opportunity on its own.
3. **Evidence must connect the event to a plausible technology problem, project, initiative or capability requirement.** Growth, funding, hiring, expansion and general company news are *contextual* evidence unless a credible technology connection exists. Contextual evidence can strengthen a real opportunity; it cannot create one.
4. **Industry is contextual, not a hard exclusion** — and equally, not a hard inclusion.
5. **Technology presence does not imply technology pain.** Detecting a technology tells you what they run, not that they need help with it. §2.1 is one instance of this principle; apply it to every fingerprint rule.
6. **Company size, revenue, funding, enterprise status and presumed budget must not dominate qualification, and must never act as a strong negative filter.** Given the $500 entry offer (§1.5), a two-person team with an AI-built app, broken authentication and a launch next week is an excellent Rubico opportunity. Immediate technology pain, urgency, evidence quality and capability fit should dominate. Any scoring change that adds "commercial potential" or "business impact" as a heavy positive weight will penalise exactly the leads the offer ladder exists to convert — argue against such a change if you find yourself proposing one.
7. **Every qualified opportunity needs an evidence-backed "why this lead" chain** a salesperson can follow without reading raw signals: *what was observed → what problem it suggests → what Rubico capability addresses it → which signal IDs support each step.* Structured, not prose. FR-AI6 already requires every claim to cite a `signalId`; this extends that to the reasoning chain.
8. **Discovery sources are pluggable evidence providers.** Do not define the architecture around today's source list. The opportunity model must be source-independent so a new source can be added without changing qualification semantics.
9. **A1′ is a breadth validation floor, not the optimisation target** (§3.5).
10. **Optimise for sales-useful opportunities, not raw company volume.** 500 relevant, well-evidenced opportunities beat 10,000 junk signals.

---

## 3. Deliverable: `analysis-p15.md`

Read the code, not just your own notes. Cite files.

### 3.1 Current-state inventory

For each, state what the code does today and where:

1. Discovery sources and their real measured yield
2. Company creation and canonical-domain flow
3. The `Signal` model and `SignalType` union — how tightly is `S1..S5` / `F-LEG` baked in?
4. The fit filter: every config key, every threshold, and precisely where it gates
5. Scoring: fit vs intent weighting, and the "only the strongest signal of each type counts" decision from P10
6. LLM classify: current Zod schema and system prompt
7. Lead creation, banding, and whether a company can ever receive a second Lead (§2.4)
8. Dedupe: what `dedupeHash` covers, and what breaks if signal types multiply
9. Enrichment: the fingerprint rule set, legacy versus modern
10. Metrics M1–M8 as derived in P14
11. The A1–A10 tests, and which of them assert on industry
12. `HACKERNEWS_QUERIES` and any other config-held discovery parameters

### 3.2 Answer this directly

> **What, specifically, prevents the current Lead Engine from discovering a technology opportunity for a non-software company?**

Name each blocker, its file, and whether it is a config change, a rule change or a code change. I expect the fit filter's industry weighting, the ATS provider set, the HN query set and the fingerprint's legacy/platform conflation to appear — but find the real list, not the expected one.

### 3.3 Gap analysis against §1

Where does the implementation's model of Rubico diverge from the verified capability map? At minimum:

- `requirement.md`'s fit criterion "stack overlaps Rubico capability (React/Node/Next)" versus the actual stack, which centres **PHP/Laravel, Angular, WordPress/WooCommerce/Magento, Flutter/Swift/Kotlin** as much as React/Node
- No archetype concept in the classifier
- No representation of `ai_code_to_production` — Rubico's hero offer, currently the single most valuable thing the engine could detect and entirely absent
- Industry as a fit weight versus industry as a contextual attribute

List the `requirement.md` amendments needed. Where the verified research contradicts `requirement.md`, the research wins.

### 3.4 Evidence-strength model — design it

Neither `requirement.md` nor the current scoring model distinguishes strength of evidence, and the broadening makes that distinction essential. These are not equivalent:

| Example | Strength |
|---|---|
| Company has a WordPress website | weakest — a capability/context fact |
| Company is hiring an ecommerce manager | moderate — an inferred initiative |
| Company announced a new ecommerce platform initiative | strong — a stated project |
| Company is requesting proposals for an ecommerce platform | strongest — direct buying intent |

Propose an evidence-strength taxonomy. Design it yourself — do not adopt a list handed to you. Then answer the harder question: **how does evidence strength enter the score?** The current intent score is per-signal-type weight × decay, which has no slot for it. Options include a per-signal multiplier, a separate score dimension, or a gate on banding. Recommend one and state the tradeoff. It must remain explainable per FR-B16.

### 3.5 Discovery prioritisation — fix A1 as part of this

A1 and the broadening are the same problem: more industries means more discovery entry points.

**Evaluate every candidate source on all of these, not on volume:** expected unique-company yield · technology-opportunity relevance · evidence strength (§3.4) · freshness · false-positive risk · implementation complexity · correctness risk · legal and ToS position · marginal cost. Then rank and recommend an order.

Candidates:

- **ATS slug discovery** — resolve a known company domain's careers page and detect its ATS. **Hypothesis: potentially high yield. Do not assume it is the highest — rank it on the criteria above with estimated numbers.**
- **Add `Workable`, `SmartRecruiters`, `Recruitee`** behind the existing `AtsProvider` interface. These skew mid-market and non-technology, i.e. Rubico's actual client profile; Greenhouse/Lever/Ashby skew tech startups, which is the bias being corrected. Same interface, no new seam.
- **Broaden `HACKERNEWS_QUERIES`** — already config, zero code.
- **Broaden ATS job-title patterns beyond engineering roles.** "Digital Transformation", "Head of Ecommerce", "Systems Analyst", "IT Manager", "Salesforce Administrator" postings at non-technology companies are technology-project signals. Note per §2.5.2 that a job posting alone is *inferred* initiative, not stated intent.
- **Press-release RSS** (PRNewswire/BusinessWire-class) for digitisation and platform announcements.
- **Public procurement / RFP feeds** — potentially the strongest evidence class available (§3.4). Assess free availability and legal position before recommending; do not assume either.
- **`sec-edgar`: I propose deprioritising it.** 0 companies under the safe resolver, ~12% name→domain resolution with at least one measured wrong match, and a wrong domain silently merges two real companies with no downstream way to notice. Lowest yield per unit of effort, highest correctness risk. Agree plainly or argue against it.

State which phases are config-only. I expect at least two, and those should come first because they are nearly free.

### 3.6 Proposed acceptance criteria

Make A1 SQL-checkable. My starting proposal, which you should improve:

> **A1′** — ≥100 companies with ≥1 dated signal, from ≥3 distinct sources, spanning ≥5 distinct `industry` values, of which ≥40 are not classifiable as software/IT.

**A1′ measures breadth of the discovery layer. It must not be achieved by lowering evidence quality or admitting weak or generic signals.** If satisfying A1′ and honouring §2.5 conflict, §2.5 wins and A1′ stays unmet — report that rather than resolving it by loosening filters.

Three further criteria I want included:

> **A11 — cost containment under broadening.** Cost per classified company must not exceed the P14 baseline. This is what proves the §2.2 gate works.

> **A12 — platform is not a defect.** No company on WordPress, WooCommerce, Shopify or Magento 2 produces an `F-LEG` signal or a modernisation-pitch brief on that basis alone.

> **A13 — classification is calibratable.** A human reviewer can record *why* an opportunity was wrong at archetype level, and that data is queryable. Inspect `Decision.reasonCode` — the current enum (`wrong_fit`, `no_real_need`, `stale`, `already_known`, `bad_contact`, `good`) cannot express "right company, wrong archetype" or "no real technology need". Propose the additions. Without this, the trigger rules, capability map and evidence-strength weights have no ground truth to tune against, and human review is the only ground truth that exists.

Then propose the rest.

### 3.7 Proposed phase plan

Phases P15 onward in your existing house style: one focused session each, explicit **Spec refs**, objectively checkable **Done when**, explicit dependency order, smallest correct change first.

**Each phase must additionally state what existing behaviour it changes and what existing behaviour it explicitly preserves.** This is how P0–P14's guarantees survive.

### 3.8 Open decisions

Every decision you believe is mine, not yours, with options and your recommendation. Do not silently choose. I expect at minimum: the industry-weighting question, `sec-edgar` deprioritisation, how far toward recall to tune the §2.2 gate, whether `Lead` becomes per-opportunity, and how evidence strength enters the score.

---

## 4. Hard constraints

Preserve every P0–P14 guarantee. Do not:

- discard or rewrite the P0–P14 implementation
- remove or weaken `MeteredClient`, or let any billable call bypass it (FR-B2)
- remove signal deduplication or company canonicalisation
- remove explainable scoring, or let scoring arithmetic leave `scoring/` (FR-B16)
- weaken the contact-resolution approval guard (FR-C5 / A9)
- install `@nestjs/schedule`, add `enableCors()`, add Redis, BullMQ, a queue, Docker-in-prod, or a job dashboard
- build an outreach *implementation* — interface only
- read `process.env` outside `common/config`, or import `common/config/index.js` from inside `src/`
- make AI responsible for classification a deterministic rule can do
- build a large industry-specific rule engine — the classification that matters is the **technology opportunity**, not the industry
- add a paid data provider
- implement scraping that breaches a site's terms, or fabricate contact data

Re-read your own §4 anti-drift checklist in `implementation.md` before finishing.

## 5. Session scope — enforced

This is a planning and review session. **Do not modify source files, tests, the Prisma schema, migrations, `package.json`, configuration files, JSON config, `.env*`, or generated artifacts.**

The only permitted repository change is creating or updating **`analysis-p15.md`**.

Draft every schema, taxonomy and JSON structure inline in that document as a proposal. I will review the plan before you build any of it.
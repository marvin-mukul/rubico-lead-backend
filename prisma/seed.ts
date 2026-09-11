import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Seeds the `scoring_config` table — one of the two non-code seams (§4).
 *
 * PROVISIONAL VALUES. The authoritative weights and half-lives live in the
 * parent spec §5, which is not in this repo. These are chosen to be sane and
 * to satisfy the §12 scoring tests; replace them once the parent spec is to
 * hand, or tune them live through PATCH /api/scoring-config (FR-SC3).
 *
 * Existing rows are left untouched — re-seeding must never reset a weight a
 * human has tuned.
 */

const SCORING_DEFAULTS: Record<string, number> = {
  // ── Signal weights and decay (§5, parent spec §5) ────────────────────────
  // S1 — funding (SEC Form D / S-1). Half-life is deliberately short: §12
  // requires a 180-day funding signal to contribute < 1 (25 × 0.5^6 = 0.39).
  'S1.weight': 25,
  'S1.halfLifeDays': 30,

  // S2 — hiring signal from ATS boards (greenhouse / lever / ashby).
  'S2.weight': 20,
  'S2.halfLifeDays': 45,

  // S3 — pain signal from Hacker News.
  'S3.weight': 15,
  'S3.halfLifeDays': 30,

  // S4 — product launch (Product Hunt).
  'S4.weight': 12,
  'S4.halfLifeDays': 60,

  // S5 — first-party intent (form fill on our own site). Highest weight,
  // fastest decay: intent goes stale quickly.
  'S5.weight': 30,
  'S5.halfLifeDays': 21,

  // S6 — a public procurement notice. The strongest evidence class here: an
  // organisation stating in public, with a budget and a deadline, that it
  // intends to buy something. Every other signal is inferred; this one is
  // declared, so it carries the highest weight. Tenders have closing dates,
  // so relevance falls off over a couple of months rather than a year.
  'S6.weight': 35,
  'S6.halfLifeDays': 45,

  // F-LEG — legacy stack flag. A standing property, not an event, so it
  // decays slowly and is re-verified weekly by maintenance.reverify-legacy.
  'F-LEG.weight': 15,
  'F-LEG.halfLifeDays': 365,

  // F-PLAT — the site runs on a platform Rubico sells work on. Weight is
  // deliberately 0: per §2.5.5 technology presence does not imply technology
  // pain, so a capability match must not push a company up the intent score
  // on its own. It is recorded as evidence the classifier and brief can cite,
  // and it feeds FIT via fit.signal.platformMatch below. P20's evidence-
  // strength model is where it gains a principled scoring role.
  'F-PLAT.weight': 0,
  'F-PLAT.halfLifeDays': 365,

  // ── Compound detection (§12) ─────────────────────────────────────────────
  // §12: "compound bonus caps at +10".
  'compound.bonus': 10,
  'compound.windowDays': 90,
  'compound.minDistinctTypes': 2,

  // ── Score composition ────────────────────────────────────────────────────
  // total = fit * fitWeight + intent * intentWeight + compoundBonus, clamped
  // to 0..100. Fit is 0..100 on its own, so it is halved to leave room for
  // intent to actually move a lead between bands.
  'score.fitWeight': 0.5,
  'score.intentWeight': 1,

  // ── Banding ──────────────────────────────────────────────────────────────
  'band.immediate.min': 70,
  'band.high.min': 50,
  'band.investigate.min': 30,

  // Points awarded per extra distinct signal type, capped by compound.bonus.
  'compound.perExtraType': 5,

  // FR-SC4: no event signal newer than this → band `ignore`, whatever the fit.
  'scoring.eventSignalFreshnessDays': 30,

  // ── Fit filter (parent spec §4.1) ────────────────────────────────────────
  // Every ICP rule is config, never code. scoring_config.value is a Float, so
  // list-shaped rules are one key per value. An attribute with no key scores
  // its dimension's `.default`.
  //
  // PROVISIONAL: the real ICP lives in the parent spec. These express a
  // plausible shape — mid-market, English-speaking, software-adjacent — so the
  // filter is exercisable end to end.
  //
  // ⚠ P15: deliberately 0, which makes the fit filter a SCORER, not a GATE.
  //
  // Nothing populates firmographics (no Enricher returns `firmographics`), so
  // industry/country/region/headcount always resolve to their `.default` of 0
  // and the reachable maximum is 20 — against the previous threshold of 40.
  // The filter therefore rejected 100% of companies and could not pass any,
  // which is why the pipeline had never classified a single record.
  //
  // The fit score still contributes to totalScore via score.fitWeight; it just
  // no longer gates. P19 installs the real gate (an opportunity trigger on
  // signal evidence), which is the right question to gate on — "is there
  // evidence of a technology problem?" rather than "is this the right kind of
  // company?" (§2.5.4: industry is contextual, not a hard exclusion).
  //
  // Exposure while this stands is bounded and small: pipeline.run takes at
  // most BATCH_LIMIT=200 companies per run, so 2 runs/day x 200 x $0.0002
  // (warm classify) = ~$0.08/day, and MeteredClient still hard-caps the month.
  'fit.minScore': 0,

  'fit.headcount.default': 0,
  'fit.headcount.1-10': 2,
  'fit.headcount.11-50': 15,
  'fit.headcount.51-200': 25,
  'fit.headcount.201-500': 20,
  'fit.headcount.501-1000': 10,
  'fit.headcount.1000': 5,

  'fit.region.default': 0,
  'fit.region.emea': 15,
  'fit.region.namer': 20,
  'fit.region.apac': 8,

  'fit.country.default': 0,
  'fit.country.us': 10,
  'fit.country.gb': 10,
  'fit.country.in': 8,
  'fit.country.ae': 8,

  'fit.industry.default': 0,
  'fit.industry.saas': 20,
  'fit.industry.fintech': 18,
  'fit.industry.ecommerce': 15,
  'fit.industry.healthcare': 12,
  'fit.industry.logistics': 12,

  // Bonuses, not dimensions.
  'fit.signal.legacyStack': 15,
  // Running a stack Rubico already staffs for is genuine fit — it says they
  // are the right kind of company, not that they need anything.
  'fit.signal.platformMatch': 10,
  'fit.signal.atsPresent': 5,
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const existing = await prisma.scoringConfig.findMany({ select: { key: true } });
    const known = new Set(existing.map((row) => row.key));

    const created: string[] = [];
    for (const [key, value] of Object.entries(SCORING_DEFAULTS)) {
      if (known.has(key)) continue;
      await prisma.scoringConfig.create({
        data: { key, value, updatedBy: 'seed' },
      });
      created.push(key);
    }

    console.log(
      `scoring_config: ${created.length} created, ${known.size} left untouched ` +
        `(${Object.keys(SCORING_DEFAULTS).length} defaults known).`,
    );
    if (created.length) console.log(`  created: ${created.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();

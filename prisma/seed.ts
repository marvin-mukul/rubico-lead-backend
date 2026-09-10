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

  // F-LEG — legacy stack flag. A standing property, not an event, so it
  // decays slowly and is re-verified weekly by maintenance.reverify-legacy.
  'F-LEG.weight': 15,
  'F-LEG.halfLifeDays': 365,

  // ── Compound detection (§12) ─────────────────────────────────────────────
  // §12: "compound bonus caps at +10".
  'compound.bonus': 10,
  'compound.windowDays': 90,
  'compound.minDistinctTypes': 2,

  // ── Banding ──────────────────────────────────────────────────────────────
  'band.immediate.min': 70,
  'band.high.min': 50,
  'band.investigate.min': 30,

  // FR-SC4: no event signal newer than this → band `ignore`, whatever the fit.
  'scoring.eventSignalFreshnessDays': 30,
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

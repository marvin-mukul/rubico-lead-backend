import { Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import type { JobContext, JobHandler } from '../jobs/index.js';

/**
 * `score.rescore-all` — nightly (§7.2).
 *
 * FR-B11: one raw SQL `UPDATE ... FROM`, not per-row Prisma writes. It must
 * finish inside 30 minutes (NFR-4) over thousands of rows.
 *
 * ⚠ This duplicates the arithmetic in `score.ts`, which is in tension with
 * FR-B16 ("scoring arithmetic exists in exactly one place"). The spec asks for
 * both, and set-based SQL cannot call a TypeScript function. The mitigation is
 * `rescore.parity.spec.ts`, which runs both implementations over the same
 * fixtures and fails if they disagree — so the duplication cannot silently
 * drift, which is the actual risk FR-B16 is guarding against.
 *
 * Every branch below mirrors a named piece of `score.ts`:
 *   per_type   → only the strongest signal of each type counts
 *   intent     → sum across types
 *   compound   → distinct event types in the window, capped
 *   fresh      → FR-SC4, no recent event signal means `ignore`
 */
export const RESCORE_SQL = `
WITH params AS (
  SELECT
    COALESCE(MAX(CASE WHEN key = 'score.fitWeight'                 THEN value END),  1) AS fit_weight,
    COALESCE(MAX(CASE WHEN key = 'score.intentWeight'              THEN value END),  1) AS intent_weight,
    COALESCE(MAX(CASE WHEN key = 'band.immediate.min'              THEN value END), 70) AS band_immediate,
    COALESCE(MAX(CASE WHEN key = 'band.high.min'                   THEN value END), 50) AS band_high,
    COALESCE(MAX(CASE WHEN key = 'band.investigate.min'            THEN value END), 30) AS band_investigate,
    COALESCE(MAX(CASE WHEN key = 'scoring.eventSignalFreshnessDays' THEN value END), 30) AS freshness_days,
    COALESCE(MAX(CASE WHEN key = 'compound.windowDays'             THEN value END), 90) AS compound_window,
    COALESCE(MAX(CASE WHEN key = 'compound.minDistinctTypes'       THEN value END),  2) AS compound_min,
    COALESCE(MAX(CASE WHEN key = 'compound.perExtraType'           THEN value END),  5) AS compound_per,
    COALESCE(MAX(CASE WHEN key = 'compound.bonus'                  THEN value END), 10) AS compound_cap
  FROM "ScoringConfig"
),
weights AS (
  SELECT
    split_part(key, '.', 1) AS type,
    COALESCE(MAX(CASE WHEN key LIKE '%.weight'       THEN value END), 0) AS weight,
    COALESCE(MAX(CASE WHEN key LIKE '%.halfLifeDays' THEN value END), 0) AS half_life
  FROM "ScoringConfig"
  WHERE key ~ '^(F-LEG|S[1-5])\\.(weight|halfLifeDays)$'
  GROUP BY 1
),
per_type AS (
  SELECT
    s."companyId",
    s.type,
    MAX(
      CASE
        -- A non-positive half-life means "does not decay", matching decay().
        WHEN w.half_life > 0 THEN w.weight * power(
          0.5,
          GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - s."eventDate")) / 86400.0) / w.half_life
        )
        ELSE w.weight
      END
    ) AS contribution
  FROM "Signal" s
  JOIN weights w ON w.type = s.type
  GROUP BY 1, 2
),
intent AS (
  SELECT "companyId", SUM(contribution) AS intent_score FROM per_type GROUP BY 1
),
fresh AS (
  SELECT "companyId", MAX("eventDate") AS latest_event
  FROM "Signal"
  WHERE type IN ('S1','S2','S3','S4','S5')
  GROUP BY 1
),
compound AS (
  SELECT s."companyId", COUNT(DISTINCT s.type) AS distinct_types
  FROM "Signal" s
  CROSS JOIN params p
  WHERE s.type IN ('S1','S2','S3','S4','S5')
    AND s."eventDate" >= $1::timestamptz - make_interval(days => p.compound_window::int)
    AND s."eventDate" <= $1::timestamptz
  GROUP BY 1
),
scored AS (
  SELECT
    l.id,
    COALESCE(i.intent_score, 0) AS intent_score,
    LEAST(
      p.compound_cap,
      GREATEST(0, COALESCE(c.distinct_types, 0) - p.compound_min + 1) * p.compound_per
    ) AS compound_bonus,
    f.latest_event,
    p.fit_weight, p.intent_weight, p.freshness_days,
    p.band_immediate, p.band_high, p.band_investigate,
    l."fitScore" AS fit_score
  FROM "Lead" l
  CROSS JOIN params p
  LEFT JOIN intent   i ON i."companyId" = l."companyId"
  LEFT JOIN compound c ON c."companyId" = l."companyId"
  LEFT JOIN fresh    f ON f."companyId" = l."companyId"
),
final AS (
  SELECT
    s.*,
    LEAST(100, GREATEST(0, ROUND((
      s.fit_score * s.fit_weight + s.intent_score * s.intent_weight + s.compound_bonus
    )::numeric)))::int AS total_score
  FROM scored s
)
UPDATE "Lead" l
SET "intentScore"   = f.intent_score,
    "compoundBonus" = f.compound_bonus::int,
    "totalScore"    = f.total_score,
    "band"          = CASE
      -- FR-SC4 first: no recent event signal means ignore, whatever the total.
      WHEN f.latest_event IS NULL
        OR f.latest_event < $1::timestamptz - make_interval(days => f.freshness_days::int)
        THEN 'ignore'
      WHEN f.total_score >= f.band_immediate    THEN 'immediate'
      WHEN f.total_score >= f.band_high         THEN 'high'
      WHEN f.total_score >= f.band_investigate  THEN 'investigate'
      ELSE 'ignore'
    END,
    "scoredAt"      = $1::timestamptz
FROM final f
WHERE f.id = l.id
`;

export class RescoreAllJob implements JobHandler {
  readonly name = 'score.rescore-all';
  private readonly logger = new Logger('Job:rescore-all');

  /**
   * The clock is injected so the parity test can pin it. Decay is a function
   * of elapsed time, so comparing this against `score.ts` is only meaningful
   * when both are evaluated at the same instant — otherwise the two disagree
   * by however long the test took to run.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(context: JobContext): Promise<void> {
    const now = this.clock();
    const startedAt = Date.now();

    const updated = await this.prisma.$executeRawUnsafe(RESCORE_SQL, now);

    context.count('scored', updated);
    this.logger.log(`Rescored ${updated} lead(s) in ${Date.now() - startedAt}ms`);
  }
}

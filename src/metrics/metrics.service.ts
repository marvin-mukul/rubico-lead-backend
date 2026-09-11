import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service.js';
import { SpendRepository } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * M1–M8 (§8.3, A8: "returns M1–M8 without manual queries").
 *
 * The parent spec names the metrics but is not in this repo, so the exact
 * definitions below are derived from what Phase 0 actually records: the
 * per-stage `counts` every run writes (FR-B8) plus the pipeline tables.
 * Each is labelled so a mismatch with the parent spec is a rename, not a
 * re-derivation.
 */
export interface FunnelRange {
  from: Date;
  to: Date;
}

interface StageCounts {
  fetched: number;
  deduped: number;
  filteredOut: number;
  classified: number;
  discarded: number;
  scored: number;
  briefed: number;
}

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spend: SpendRepository,
    private readonly config: AppConfigService,
  ) {}

  /** Default window: the last 30 days. */
  resolveRange(from?: string, to?: string): FunnelRange {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 86_400_000);
    return { from: fromDate, to: toDate };
  }

  async funnel(range: FunnelRange) {
    const [stages, companiesDiscovered, signalsIngested, byBand, decisions] = await Promise.all([
      this.sumJobCounts(range),
      this.prisma.company.count({ where: { firstSeenAt: { gte: range.from, lte: range.to } } }),
      this.prisma.signal.count({ where: { observedAt: { gte: range.from, lte: range.to } } }),
      this.prisma.lead.groupBy({
        by: ['band'],
        _count: true,
        where: { scoredAt: { gte: range.from, lte: range.to } },
      }),
      this.decisionStats(range),
    ]);

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      m1_signalsIngested: signalsIngested,
      m2_companiesDiscovered: companiesDiscovered,
      // Everything that reached classification passed the fit filter.
      m3_passedFitFilter: stages.classified,
      m4_classified: stages.classified,
      // FR-AI5 refusals. A classifier that never refuses shows up here as 0.
      m5_discardedByClassifier: stages.discarded,
      m6_leadsScored: stages.scored,
      m7_briefsGenerated: stages.briefed,
      m8_decisions: decisions,
      byBand: Object.fromEntries(byBand.map((row) => [row.band, row._count])),
    };
  }

  /**
   * M6 calibration uses `Decision.scoreAtDecision` — the score the human
   * actually saw — never `Lead.totalScore`, which has moved every night
   * since (FR-B3).
   */
  private async decisionStats(range: FunnelRange) {
    const window = { decidedAt: { gte: range.from, lte: range.to } };

    const [overall, management, builder] = await Promise.all([
      this.decisionTotals(window),
      this.decisionTotals({ ...window, attribution: 'management' }),
      this.decisionTotals({ ...window, attribution: 'builder' }),
    ]);

    return {
      ...overall,
      /**
       * FR-W18 / addendum FR-L12: the split, kept separate from the total.
       *
       * M4 and M5 count only `management`. The Day-30 review is the builder
       * sitting with a management reviewer and recording their verdicts, and
       * a builder's own opinion of their own engine is not evidence. Rolling
       * the two together produces a number that looks like validation and
       * is not, which is worse than having no number.
       *
       * The overall figures stay alongside rather than being replaced —
       * "how much reviewing happened" and "how much of it counts" are
       * different questions and the Day-30 review asks both.
       */
      byAttribution: { management, builder },
    };
  }

  private async decisionTotals(where: Prisma.DecisionWhereInput) {
    const [approved, rejected] = await Promise.all([
      this.prisma.decision.aggregate({
        _count: true,
        _avg: { scoreAtDecision: true },
        where: { ...where, decision: 'approved' },
      }),
      this.prisma.decision.aggregate({
        _count: true,
        _avg: { scoreAtDecision: true },
        where: { ...where, decision: 'rejected' },
      }),
    ]);

    const total = approved._count + rejected._count;
    return {
      approved: approved._count,
      rejected: rejected._count,
      approvalRate: total === 0 ? 0 : approved._count / total,
      meanScoreApproved: approved._avg.scoreAtDecision,
      meanScoreRejected: rejected._avg.scoreAtDecision,
    };
  }

  /** FR-B8: `job_runs.counts` is the source for the funnel. */
  private async sumJobCounts(range: FunnelRange): Promise<StageCounts> {
    const runs = await this.prisma.jobRun.findMany({
      // Same `{ not: undefined }` no-op as pipeline-run's pending() had: it
      // collapsed away and fetched every run, null counts included. Harmless
      // here because the loop below skips them, but it fetched rows for
      // nothing.
      where: {
        createdAt: { gte: range.from, lte: range.to },
        NOT: { counts: { equals: Prisma.DbNull } },
      },
      select: { counts: true },
    });

    const totals: StageCounts = {
      fetched: 0,
      deduped: 0,
      filteredOut: 0,
      classified: 0,
      discarded: 0,
      scored: 0,
      briefed: 0,
    };

    for (const run of runs) {
      const counts = (run.counts ?? {}) as Partial<Record<keyof StageCounts, unknown>>;
      for (const key of Object.keys(totals) as Array<keyof StageCounts>) {
        const value = counts[key];
        if (typeof value === 'number') totals[key] += value;
      }
    }
    return totals;
  }

  async spendSummary() {
    const [monthToDateUsd, todayUsd, byProvider, qualified] = await Promise.all([
      this.spend.monthToDateTotalUsd(),
      this.spend.todayUsd(),
      this.spend.byProviderMonthToDate(),
      // "Qualified opportunity" = a lead a human approved. Cost per
      // qualified opportunity is the number that decides whether this
      // engine is worth running at all.
      this.prisma.lead.count({ where: { status: 'approved' } }),
    ]);

    return {
      monthToDateUsd,
      todayUsd,
      monthlyCapUsd: this.config.caps.monthlyUsd,
      byProvider,
      qualifiedOpportunities: qualified,
      costPerQualifiedOpportunityUsd: qualified === 0 ? null : monthToDateUsd / qualified,
    };
  }
}

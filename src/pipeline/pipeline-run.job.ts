import { Injectable, Logger } from '@nestjs/common';
import { EVENT_SIGNAL_TYPES } from '../common/domain/index.js';
import { MeteringError } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { FitFilterService, SuppressionService } from '../companies/index.js';
import { EnrichmentService } from '../enrichment/index.js';
import type { CompanyModel as Company } from '../generated/prisma/models.js';
import type { JobContext, JobHandler } from '../jobs/index.js';
import {
  BriefService,
  ClassifyService,
  type BriefRequest,
  type ClassifiableSignal,
  type ClassificationOutcome,
} from '../llm/index.js';
import { OpportunityTriggerService } from '../opportunity/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import { ScoringService } from '../scoring/index.js';

/**
 * How much of the backlog one run will take on, when `pipeline.batchLimit`
 * is not configured.
 *
 * The limit is only safe because `pending()` orders by `lastPipelineRunAt`
 * ascending. Ordering by `firstSeenAt: desc` with a limit — which is what
 * this did before — meant the newest 200 companies were re-read on every run
 * and everything older was NEVER processed. With 523 eligible companies, 323
 * of them were permanently invisible.
 */
const DEFAULT_BATCH_LIMIT = 200;
/** Re-enrich a company at most this often. */
const ENRICH_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * `pipeline.run` — enrich → classify → score → brief, for all pending (§7.2).
 *
 * FR-B10: one job, not four chained ones. Fewer moving parts in n8n, and the
 * stage boundaries are already visible in `counts`.
 *
 * FR-B9: per record, not per batch. One company failing is counted and
 * skipped; everything committed before it stays committed.
 *
 * FR-C2 is the one exception to that. A cap breach is not a per-record
 * problem — it means the budget is gone — so it propagates immediately and
 * halts the run rather than being caught and counted 200 times.
 */
@Injectable()
export class PipelineRunJob implements JobHandler {
  readonly name = 'pipeline.run';
  private readonly logger = new Logger('Job:pipeline.run');

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichment: EnrichmentService,
    private readonly fitFilter: FitFilterService,
    private readonly classify: ClassifyService,
    private readonly scoring: ScoringService,
    private readonly briefs: BriefService,
    private readonly scoringConfig: ScoringConfigService,
    private readonly triggers: OpportunityTriggerService,
  ) {}

  async run(context: JobContext): Promise<void> {
    const companies = await this.pending();
    this.logger.log(`${companies.length} company(ies) pending`);
    context.count('fetched', companies.length);

    const briefRequests: BriefRequest[] = [];

    for (const company of companies) {
      try {
        const request = await this.processCompany(company, context);
        if (request) briefRequests.push(request);
      } catch (error) {
        // FR-C2: the budget is gone. Halting is the point — degrading
        // quietly is what the cap exists to prevent. Deliberately re-thrown
        // BEFORE marking: nothing was examined, so the company keeps its
        // place in the queue.
        if (error instanceof MeteringError) throw error;

        context.count('failed');
        this.logger.warn(
          `${company.canonicalDomain} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // After the attempt, whatever happened. A company that was filtered,
      // discarded or errored still consumed a slot.
      await this.markExamined(company.id, context);
    }

    await this.writeBriefs(briefRequests, context);
  }

  /**
   * Companies worth spending on: active and **carrying fresh evidence**.
   *
   * The freshness clause is the point. FR-SC4 already forces a company whose
   * newest event signal is stale into band `ignore` — but scoring it
   * correctly and paying for it are different things. Without this filter the
   * pipeline still enriches and classifies those companies to produce a lead
   * that can only ever be `ignore`. Measured on real data: 117 of 640
   * companies, every run, forever.
   *
   * Uses the same `scoring.eventSignalFreshnessDays` knob as FR-SC4, so the
   * thing we spend on and the thing that can be banded stay in step by
   * construction rather than by two numbers that drift apart.
   *
   * P21: there is deliberately no `leads`-based exclusion here any more. The
   * pre-P21 filter (`leads: { none: { ...has a brief... } } }`) meant a
   * company that ever acquired one briefed lead was NEVER reprocessed again,
   * whatever happened afterwards — new signals could never surface a SECOND
   * opportunity at an already-known company (§2.4). Freshness is what bounds
   * reprocessing now: a company drops out of `pending()` on its own once its
   * newest event signal ages past the freshness window, exactly as before —
   * it just no longer stays out forever because it once got one brief.
   * `upsertLead`'s per-opportunity upsert (composite unique on
   * `companyId, opportunityKey`) is what stops re-classifying a STABLE
   * opportunity from producing duplicate leads or duplicate spend: the same
   * archetype re-scores the same row, and `processCompany` only requests a
   * fresh brief when the lead is new or has never had one.
   */
  private async pending(): Promise<Company[]> {
    const freshnessDays = await this.scoringConfig.get('scoring.eventSignalFreshnessDays', 30);
    const freshSince = new Date(Date.now() - freshnessDays * 24 * 60 * 60 * 1000);
    const batchLimit = await this.scoringConfig.get('pipeline.batchLimit', DEFAULT_BATCH_LIMIT);

    return this.prisma.company.findMany({
      where: {
        ...SuppressionService.activeFilter(),
        signals: {
          some: {
            type: { in: [...EVENT_SIGNAL_TYPES] },
            eventDate: { gte: freshSince },
          },
        },
      },
      // Least-recently-examined first, never-examined before that. This is
      // what makes the batch limit a throughput control rather than a
      // permanent cut-off: every eligible company reaches the front of the
      // queue eventually, and the whole set cycles in
      // (eligible / batchLimit / runsPerDay) days.
      orderBy: [{ lastPipelineRunAt: { sort: 'asc', nulls: 'first' } }, { firstSeenAt: 'desc' }],
      take: batchLimit,
    });
  }

  /**
   * Records that the pipeline examined this company, whatever the outcome.
   *
   * It must be set for filtered, discarded and errored companies too. Marking
   * only successes would leave those rows with a null timestamp, permanently
   * at the front of the ordering, monopolising every batch — the starvation
   * bug inverted rather than fixed.
   *
   * `updateMany`, not `update`: the company can be gone by the time we get
   * here — deleted or merged between `pending()` and now — and `update`
   * throws on a missing row. This is bookkeeping; it must never abort a run
   * that has already done its real work.
   */
  private async markExamined(companyId: string, context: JobContext): Promise<void> {
    if (context.dryRun) return;
    await this.prisma.company.updateMany({
      where: { id: companyId },
      data: { lastPipelineRunAt: new Date() },
    });
  }

  private async processCompany(
    company: Company,
    context: JobContext,
  ): Promise<BriefRequest | null> {
    // ── enrich ────────────────────────────────────────────────────────────
    const stale =
      !company.lastEnrichedAt || company.lastEnrichedAt.getTime() < Date.now() - ENRICH_STALE_MS;
    if (stale && !context.dryRun) {
      await this.enrichment.enrichCompany(company);
      context.count('enriched');
    }

    const current = await this.prisma.company.findUniqueOrThrow({ where: { id: company.id } });

    // ── fit filter ────────────────────────────────────────────────────────
    const fit = await this.fitFilter.evaluate({
      country: current.country,
      region: current.region,
      headcountBand: current.headcountBand,
      industry: current.industry,
      atsProvider: current.atsProvider,
      hasLegacyFlags: hasLegacyMarkers(current.legacyFlags),
      hasPlatformMatch: hasPlatformMarkers(current.detectedStack),
    });

    // Retained as an operator kill switch rather than a gate: with
    // `fit.minScore` at 0 this never blocks, and industry must not be a hard
    // exclusion (§2.5.4). The trigger below is what actually gates.
    if (!fit.passes) {
      context.count('filteredOut');
      return null;
    }

    const signals = await this.loadSignals(current.id);

    // ── the gate (§2.2) ───────────────────────────────────────────────────
    // Deterministic, free, and the last thing between this company and a
    // billable call. The fit filter above scores; this decides.
    const trigger = this.triggers.evaluate(signals);
    if (!trigger.passed) {
      context.count('noTrigger');
      this.logger.debug(`${current.canonicalDomain}: no opportunity trigger matched`);
      return null;
    }

    if (context.dryRun) return null;

    // ── classify ──────────────────────────────────────────────────────────
    const outcome = await this.classify.classify(
      {
        id: current.id,
        canonicalDomain: current.canonicalDomain,
        name: current.name,
        country: current.country,
        industry: current.industry,
        headcountBand: current.headcountBand,
        detectedStack: current.detectedStack,
        legacyFlags: current.legacyFlags,
      },
      signals,
    );
    context.count('classified');
    await this.recordClassification(current.id, outcome);

    // FR-AI5: a refusal discards the record BEFORE scoring, so no lead row,
    // no score, and above all no brief is ever paid for.
    if (!outcome.keep) {
      context.count('discarded');
      this.logger.debug(`${current.canonicalDomain} discarded: ${outcome.discardReason}`);
      return null;
    }

    // ── score ─────────────────────────────────────────────────────────────
    // P21/P22: the archetype IS the opportunity key. A company already
    // holding a `fix_slowing_software` lead gets a new row for
    // `ai_code_to_production` rather than an overwrite. `'general'` is a
    // defensive fallback only — the classifier should never confirm an
    // opportunity (outcome.keep) while naming archetype 'none'.
    const opportunityKey =
      outcome.classification.archetype === 'none' ? 'general' : outcome.classification.archetype;
    const lead = await this.scoring.upsertLead(current.id, opportunityKey, fit.fitScore);
    await this.classify.saveToLead(lead.id, outcome);
    context.count('scored');

    // Only pay for a brief when there is something new to say: a brand new
    // opportunity, or one that has never had a brief (the P16 retry path).
    // A stable, already-briefed opportunity re-scored on a subsequent run —
    // because its evidence is still fresh — does not regenerate its brief.
    if (!lead.isNew && lead.hadBrief) return null;

    return {
      leadId: lead.id,
      company: {
        id: current.id,
        canonicalDomain: current.canonicalDomain,
        name: current.name,
        country: current.country,
        industry: current.industry,
        headcountBand: current.headcountBand,
        detectedStack: current.detectedStack,
        legacyFlags: current.legacyFlags,
      },
      signals,
      likelyNeed: outcome.classification.likely_need,
    };
  }

  /** FR-AI3: one batch for the whole run, at half price. */
  private async writeBriefs(requests: BriefRequest[], context: JobContext): Promise<void> {
    if (requests.length === 0) return;

    const outcomes = await this.briefs.generate(requests);
    for (const outcome of outcomes) {
      if (outcome.brief) {
        context.count('briefed');
      } else {
        // A rejected brief is a defect, already logged by BriefService. The
        // lead keeps its score and stays visible; it simply has no brief.
        context.count('failed');
      }
    }
  }

  /**
   * Funnel visibility (M4/M5): records the classifier's verdict on the
   * company it was already computed for, rather than letting it evaporate
   * once `processCompany` returns. Purely additive bookkeeping — read by
   * `FunnelService` only; nothing in this job or `ClassifyService` reads it
   * back, so it cannot affect what the pipeline decides.
   *
   * `updateMany`, not `update` — same reasoning as `markExamined`: the
   * company can be gone by the time this runs (deleted or merged mid-run),
   * and bookkeeping must never abort a run that has already done its real
   * classify/score/brief work over a missing row.
   */
  private async recordClassification(
    companyId: string,
    outcome: ClassificationOutcome,
  ): Promise<void> {
    await this.prisma.company.updateMany({
      where: { id: companyId },
      data: {
        lastClassifiedAt: new Date(),
        lastClassifyKeep: outcome.keep,
        lastClassification:
          outcome.keep ?
            {
              likelyNeed: outcome.classification.likely_need,
              archetype: outcome.classification.archetype,
            }
          : { reason: outcome.discardReason ?? null },
      },
    });
  }

  private async loadSignals(companyId: string): Promise<ClassifiableSignal[]> {
    const rows = await this.prisma.signal.findMany({
      where: { companyId },
      orderBy: { eventDate: 'desc' },
      take: 40,
      select: {
        id: true,
        type: true,
        eventDate: true,
        sourceName: true,
        sourceUrl: true,
        excerpt: true,
      },
    });
    return rows;
  }
}

export function hasLegacyMarkers(legacyFlags: unknown): boolean {
  if (!legacyFlags || typeof legacyFlags !== 'object') return false;
  return Object.keys(legacyFlags as Record<string, unknown>).some((key) => key !== 'checkedAt');
}

/** Platform markers live inside detectedStack — they are capabilities. */
const SERVICED_PLATFORMS = [
  'wordpress',
  'woocommerce',
  'shopify',
  'magento2',
  'laravel',
  'drupal-current',
];

export function hasPlatformMarkers(detectedStack: unknown): boolean {
  if (!detectedStack || typeof detectedStack !== 'object') return false;
  const keys = Object.keys(detectedStack as Record<string, unknown>);
  return SERVICED_PLATFORMS.some((platform) => keys.includes(platform));
}

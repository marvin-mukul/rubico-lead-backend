import { Injectable, Logger } from '@nestjs/common';
import { MeteringError } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { FitFilterService, SuppressionService } from '../companies/index.js';
import { EnrichmentService } from '../enrichment/index.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CompanyModel as Company } from '../generated/prisma/models.js';
import type { JobContext, JobHandler } from '../jobs/index.js';
import {
  BriefService,
  ClassifyService,
  type BriefRequest,
  type ClassifiableSignal,
} from '../llm/index.js';
import { ScoringService } from '../scoring/index.js';

/** How much of the backlog one run will take on. */
const BATCH_LIMIT = 200;
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
        // quietly is what the cap exists to prevent.
        if (error instanceof MeteringError) throw error;

        context.count('failed');
        this.logger.warn(
          `${company.canonicalDomain} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.writeBriefs(briefRequests, context);
  }

  /**
   * Companies worth spending on: active, with signals, not already briefed.
   *
   * ⚠ The obvious spelling of the last clause is a silent no-op. Prisma
   * strips `undefined` from filters, so `brief: { not: undefined }` collapses
   * to `{}` and `leads: { none: {} }` means "companies with no leads AT ALL".
   * That capped every company at one Lead for life and killed the brief-retry
   * path AnthropicProvider depends on when a batch misses its poll window.
   * `NOT: { brief: { equals: Prisma.DbNull } }` is the spelling that
   * survives. Plain `null` is rejected by the typed API for a nullable Json
   * column, because Prisma distinguishes a SQL NULL (`DbNull`) from a JSON
   * `null` literal (`JsonNull`); an absent brief is the former.
   */
  private async pending(): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: {
        ...SuppressionService.activeFilter(),
        signals: { some: {} },
        leads: { none: { NOT: { brief: { equals: Prisma.DbNull } } } },
      },
      orderBy: { firstSeenAt: 'desc' },
      take: BATCH_LIMIT,
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
    });

    if (!fit.passes) {
      context.count('filteredOut');
      return null;
    }

    const signals = await this.loadSignals(current.id);
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

    // FR-AI5: a refusal discards the record BEFORE scoring, so no lead row,
    // no score, and above all no brief is ever paid for.
    if (!outcome.keep) {
      context.count('discarded');
      this.logger.debug(`${current.canonicalDomain} discarded: ${outcome.discardReason}`);
      return null;
    }

    // ── score ─────────────────────────────────────────────────────────────
    const leadId = await this.scoring.upsertLead(current.id, fit.fitScore);
    await this.classify.saveToLead(leadId, outcome);
    context.count('scored');

    return {
      leadId,
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

function hasLegacyMarkers(legacyFlags: unknown): boolean {
  if (!legacyFlags || typeof legacyFlags !== 'object') return false;
  return Object.keys(legacyFlags as Record<string, unknown>).some((key) => key !== 'checkedAt');
}

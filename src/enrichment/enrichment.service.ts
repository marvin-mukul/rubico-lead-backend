import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import type { CompanyModel as Company } from '../generated/prisma/models.js';
import type { JobContext } from '../jobs/index.js';
import { SignalRepository } from '../signals/index.js';
import { ENRICHER, type Enricher, type EnrichmentResult } from './enricher.interface.js';

/** How long enrichment stays fresh before the pipeline redoes it. */
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    @Inject(ENRICHER) private readonly enrichers: Enricher[],
    private readonly prisma: PrismaService,
    private readonly signals: SignalRepository,
  ) {}

  /**
   * Runs every registered enricher against one company.
   *
   * An individual enricher failing is expected — homepages 403, DNS times
   * out, GitHub rate limits — and must not lose the results of the others or
   * fail the record. Each is caught, logged and skipped.
   */
  async enrichCompany(company: Company): Promise<EnrichmentResult> {
    const merged: EnrichmentResult = { detectedStack: {}, legacyFlags: {} };

    for (const enricher of this.enrichers) {
      try {
        const result = await enricher.enrich(company);
        Object.assign(merged.detectedStack!, result.detectedStack ?? {});
        Object.assign(merged.legacyFlags!, result.legacyFlags ?? {});
        if (result.firmographics) {
          merged.firmographics = { ...merged.firmographics, ...result.firmographics };
        }
        if (result.atsProvider) merged.atsProvider = result.atsProvider;
        if (result.atsSlug) merged.atsSlug = result.atsSlug;
      } catch (error) {
        this.logger.debug(
          `${enricher.name} failed for ${company.canonicalDomain}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.prisma.company.update({
      where: { id: company.id },
      data: {
        detectedStack: merged.detectedStack as never,
        legacyFlags: merged.legacyFlags as never,
        lastEnrichedAt: new Date(),
        ...merged.firmographics,
        ...(merged.atsProvider ? { atsProvider: merged.atsProvider } : {}),
        ...(merged.atsSlug ? { atsSlug: merged.atsSlug } : {}),
      },
    });

    await this.syncLegacySignal(company, merged);
    return merged;
  }

  /**
   * `F-LEG` is a standing property, so it gets exactly one signal per company
   * — dated when the flag was first raised, not when it was last confirmed.
   *
   * Re-dating it on every weekly re-verification would make an unchanged fact
   * look like fresh news, and its decay curve would never fall. When the
   * flags clear, the signal is removed so the company stops being scored for
   * a stack it no longer runs (FR-S5).
   */
  private async syncLegacySignal(company: Company, result: EnrichmentResult): Promise<void> {
    const isLegacy = Object.keys(result.legacyFlags ?? {}).some((key) => key !== 'checkedAt');
    const existing = await this.prisma.signal.findFirst({
      where: { companyId: company.id, type: 'F-LEG' },
      select: { id: true },
    });

    if (isLegacy && !existing) {
      await this.signals.insert({
        companyId: company.id,
        type: 'F-LEG',
        eventDate: new Date(),
        sourceUrl: `https://${company.canonicalDomain}/`,
        sourceName: 'homepage-fingerprint',
        subject: 'legacy-stack',
        excerpt: `Legacy markers: ${Object.keys(result.legacyFlags ?? {})
          .filter((key) => key !== 'checkedAt')
          .join(', ')}`,
        raw: (result.legacyFlags ?? {}) as never,
      });
      this.logger.log(`F-LEG raised for ${company.canonicalDomain}`);
    } else if (!isLegacy && existing) {
      await this.prisma.signal.delete({ where: { id: existing.id } });
      this.logger.log(`F-LEG cleared for ${company.canonicalDomain}`);
    }
  }

  /** Companies never enriched, or enriched longer ago than the staleness window. */
  async findStale(limit = 200): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: {
        suppressionReason: null,
        OR: [
          { lastEnrichedAt: null },
          { lastEnrichedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
        ],
      },
      orderBy: { lastEnrichedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
  }

  /** Companies already flagged legacy, for `maintenance.reverify-legacy`. */
  async findLegacyFlagged(limit = 500): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: { suppressionReason: null, signals: { some: { type: 'F-LEG' } } },
      take: limit,
    });
  }

  async enrichBatch(companies: Company[], context: JobContext): Promise<void> {
    for (const company of companies) {
      try {
        await this.enrichCompany(company);
        context.count('enriched');
      } catch (error) {
        context.count('failed');
        this.logger.warn(
          `Enrichment failed for ${company.canonicalDomain}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

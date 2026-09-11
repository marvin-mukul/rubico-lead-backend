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
    const merged: EnrichmentResult = { detectedStack: {}, legacyFlags: {}, platformFlags: {} };

    for (const enricher of this.enrichers) {
      try {
        const result = await enricher.enrich(company);
        Object.assign(merged.detectedStack!, result.detectedStack ?? {});
        Object.assign(merged.legacyFlags!, result.legacyFlags ?? {});
        Object.assign(merged.platformFlags!, result.platformFlags ?? {});
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

    await this.syncStandingSignals(company, merged);
    return merged;
  }

  /**
   * `F-LEG` and `F-PLAT` are standing properties, so each gets at most one
   * signal per company — dated when it was first raised, not when it was
   * last confirmed. Re-dating on every weekly re-verification would make an
   * unchanged fact look like fresh news and its decay curve would never fall.
   * When the markers clear, the signal is removed (FR-S5).
   *
   * The two are independent. A WooCommerce store running jQuery 1.x holds
   * both: a capability match AND a modernisation lead.
   */
  private async syncStandingSignals(company: Company, result: EnrichmentResult): Promise<void> {
    await this.syncStanding(
      company,
      'F-LEG',
      result.legacyFlags ?? {},
      'Legacy markers',
      'homepage-fingerprint',
    );
    await this.syncStanding(
      company,
      'F-PLAT',
      result.platformFlags ?? {},
      'Rubico-serviced platform',
      'homepage-fingerprint',
    );
  }

  private async syncStanding(
    company: Company,
    type: 'F-LEG' | 'F-PLAT',
    flags: Record<string, unknown>,
    label: string,
    sourceName: string,
  ): Promise<void> {
    const markers = Object.keys(flags).filter((key) => key !== 'checkedAt');
    const present = markers.length > 0;

    const existing = await this.prisma.signal.findFirst({
      where: { companyId: company.id, type },
      select: { id: true },
    });

    if (present && !existing) {
      await this.signals.insert({
        companyId: company.id,
        type,
        eventDate: new Date(),
        sourceUrl: `https://${company.canonicalDomain}/`,
        sourceName,
        subject: type === 'F-LEG' ? 'legacy-stack' : 'serviced-platform',
        excerpt: `${label}: ${markers.join(', ')}`,
        raw: flags as never,
      });
      this.logger.log(`${type} raised for ${company.canonicalDomain} (${markers.join(', ')})`);
    } else if (!present && existing) {
      await this.prisma.signal.delete({ where: { id: existing.id } });
      this.logger.log(`${type} cleared for ${company.canonicalDomain}`);
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

  /**
   * Companies carrying a standing signal, for `maintenance.reverify-legacy`.
   *
   * Includes F-PLAT as well as F-LEG: re-verification is how a wrongly-raised
   * standing signal gets cleared, and that has to work in both directions.
   */
  async findLegacyFlagged(limit = 500): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: {
        suppressionReason: null,
        signals: { some: { type: { in: ['F-LEG', 'F-PLAT'] } } },
      },
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

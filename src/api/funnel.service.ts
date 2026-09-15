import { Injectable } from '@nestjs/common';
import { FitFilterService } from '../companies/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { hasLegacyMarkers, hasPlatformMarkers } from '../pipeline/pipeline-run.job.js';
import type { FunnelClassificationQuery, FunnelPageQuery } from './dto.js';

/** Midnight after `date` (YYYY-MM-DD), so a `to` bound includes its own day. */
function nextDay(date: string): Date {
  const midnight = new Date(`${date}T00:00:00.000Z`);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  return midnight;
}

function dateRange(query: FunnelPageQuery) {
  if (!query.from && !query.to) return undefined;
  return {
    ...(query.from ? { gte: new Date(query.from) } : {}),
    ...(query.to ? { lt: nextDay(query.to) } : {}),
  };
}

/**
 * Read-only visibility onto M1–M7 (§ funnel), one record at a time, so a
 * human can see what is actually inside the numbers Metrics only counts.
 *
 * Nothing here changes what the pipeline does. M3's fit check is recomputed
 * live through the exact `FitFilterService` the pipeline itself calls —
 * never a second implementation — so it can drift from what Metrics' M3
 * counted historically (config or company data may have changed since), but
 * it never drifts from what the real gate would do today.
 */
@Injectable()
export class FunnelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fitFilter: FitFilterService,
  ) {}

  /** M1 — every ingested signal, newest observed first. */
  async signals(query: FunnelPageQuery) {
    const range = dateRange(query);
    const where = range ? { observedAt: range } : {};

    const [total, rows] = await Promise.all([
      this.prisma.signal.count({ where }),
      this.prisma.signal.findMany({
        where,
        orderBy: { observedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { company: { select: { canonicalDomain: true, name: true } } },
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      signals: rows.map((signal) => ({
        id: signal.id,
        companyId: signal.companyId,
        canonicalDomain: signal.company.canonicalDomain,
        companyName: signal.company.name,
        type: signal.type,
        eventDate: signal.eventDate.toISOString(),
        observedAt: signal.observedAt.toISOString(),
        sourceName: signal.sourceName,
        sourceUrl: signal.sourceUrl,
        excerpt: signal.excerpt,
        evidenceStrength: signal.evidenceStrength,
      })),
    };
  }

  /**
   * M2 (every row) / M3 (rows where `passesFitFilter` is true, on the
   * frontend — see the field's own comment in dto.ts for why this stays a
   * client-side view rather than a server filter: the fit check is computed
   * live, per page, not stored, so there is no column to filter on in SQL
   * without duplicating the pipeline's own check as a second implementation.
   */
  async companies(query: FunnelPageQuery) {
    const range = dateRange(query);
    const where = range ? { firstSeenAt: range } : {};

    const [total, rows] = await Promise.all([
      this.prisma.company.count({ where }),
      this.prisma.company.findMany({
        where,
        orderBy: { firstSeenAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { signals: true } } },
      }),
    ]);

    const companyIds = rows.map((row) => row.id);
    const [latestSignals, emails, fitResults] = await Promise.all([
      this.prisma.signal.groupBy({
        by: ['companyId'],
        where: { companyId: { in: companyIds } },
        _max: { eventDate: true },
      }),
      this.latestEmailByCompany(companyIds),
      Promise.all(
        rows.map((company) =>
          this.fitFilter.evaluate({
            country: company.country,
            region: company.region,
            headcountBand: company.headcountBand,
            industry: company.industry,
            atsProvider: company.atsProvider,
            hasLegacyFlags: hasLegacyMarkers(company.legacyFlags),
            hasPlatformMatch: hasPlatformMarkers(company.detectedStack),
          }),
        ),
      ),
    ]);
    const latestByCompany = new Map(
      latestSignals.map((row) => [row.companyId, row._max.eventDate ?? null]),
    );

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      companies: rows.map((company, index) => ({
        id: company.id,
        canonicalDomain: company.canonicalDomain,
        name: company.name,
        country: company.country,
        region: company.region,
        industry: company.industry,
        headcountBand: company.headcountBand,
        firstSeenAt: company.firstSeenAt.toISOString(),
        lastEnrichedAt: company.lastEnrichedAt?.toISOString() ?? null,
        suppressionReason: company.suppressionReason,
        signalCount: company._count.signals,
        latestSignalAt: latestByCompany.get(company.id)?.toISOString() ?? null,
        fitScore: fitResults[index]!.fitScore,
        passesFitFilter: fitResults[index]!.passes,
        email: emails.get(company.id) ?? null,
      })),
    };
  }

  /** M4 (every classified company) / M5 (`keep=false` only). */
  async classifications(query: FunnelClassificationQuery) {
    const where = {
      lastClassifiedAt: { not: null, ...dateRange(query) },
      ...(query.keep === undefined ? {} : { lastClassifyKeep: query.keep === 'true' }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.company.count({ where }),
      this.prisma.company.findMany({
        where,
        orderBy: { lastClassifiedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const emails = await this.latestEmailByCompany(rows.map((row) => row.id));

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      classifications: rows.map((company) => {
        const detail = (company.lastClassification ?? {}) as {
          reason?: string;
          likelyNeed?: string;
          archetype?: string | null;
        };
        return {
          companyId: company.id,
          canonicalDomain: company.canonicalDomain,
          companyName: company.name,
          keep: company.lastClassifyKeep ?? false,
          reason: detail.reason ?? null,
          likelyNeed: detail.likelyNeed ?? null,
          archetype: detail.archetype ?? null,
          // Non-null by construction of the `where` clause above.
          classifiedAt: company.lastClassifiedAt!.toISOString(),
          email: emails.get(company.id) ?? null,
        };
      }),
    };
  }

  /** Most recently resolved contact email per company. Batched — never N+1. */
  private async latestEmailByCompany(companyIds: string[]): Promise<Map<string, string | null>> {
    if (companyIds.length === 0) return new Map();
    const contacts = await this.prisma.contact.findMany({
      where: { companyId: { in: companyIds }, email: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      select: { companyId: true, email: true },
    });
    const byCompany = new Map<string, string | null>();
    for (const contact of contacts) {
      // First hit per company wins — `orderBy: resolvedAt desc` means that's
      // the most recently resolved one.
      if (!byCompany.has(contact.companyId)) byCompany.set(contact.companyId, contact.email);
    }
    return byCompany;
  }
}

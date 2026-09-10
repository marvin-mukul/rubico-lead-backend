import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';

/**
 * FR-B12: the daily digest is a **pull** endpoint. n8n already owns
 * scheduling, so the backend has no webhook URL, no retry logic and no
 * delivery-failure handling for it — the three things that would otherwise
 * need building, testing and monitoring.
 */
@Injectable()
export class DigestService {
  constructor(private readonly prisma: PrismaService) {}

  async daily(date?: string) {
    const day = date ? new Date(`${date}T00:00:00.000Z`) : startOfUtcDay(new Date());
    const next = new Date(day.getTime() + 86_400_000);

    const leads = await this.prisma.lead.findMany({
      where: {
        scoredAt: { gte: day, lt: next },
        band: { in: ['immediate', 'high', 'investigate'] },
        // A lead already decided on is not news.
        status: 'new',
      },
      orderBy: [{ totalScore: 'desc' }],
      include: {
        company: { select: { canonicalDomain: true, name: true } },
      },
    });

    const counts = { immediate: 0, high: 0, investigate: 0 };
    for (const lead of leads) {
      if (lead.band in counts) counts[lead.band as keyof typeof counts]++;
    }

    // One representative source URL per lead, so the reader can click
    // through to the evidence rather than trusting the summary.
    const topEvidence = await this.topEvidenceByCompany(leads.map((lead) => lead.companyId));

    return {
      date: day.toISOString().slice(0, 10),
      counts,
      leads: leads.map((lead) => ({
        id: lead.id,
        canonicalDomain: lead.company.canonicalDomain,
        companyName: lead.company.name,
        band: lead.band,
        totalScore: lead.totalScore,
        likelyNeed: lead.likelyNeed,
        rubicoService: lead.rubicoService,
        headline: headlineOf(lead.brief),
        topEvidenceUrl: topEvidence.get(lead.companyId) ?? null,
      })),
    };
  }

  private async topEvidenceByCompany(companyIds: string[]): Promise<Map<string, string>> {
    if (companyIds.length === 0) return new Map();
    const signals = await this.prisma.signal.findMany({
      where: { companyId: { in: companyIds } },
      orderBy: { eventDate: 'desc' },
      select: { companyId: true, sourceUrl: true },
    });

    const out = new Map<string, string>();
    for (const signal of signals) {
      if (!out.has(signal.companyId)) out.set(signal.companyId, signal.sourceUrl);
    }
    return out;
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function headlineOf(brief: unknown): string | null {
  if (!brief || typeof brief !== 'object') return null;
  const headline = (brief as { headline?: unknown }).headline;
  return typeof headline === 'string' ? headline : null;
}

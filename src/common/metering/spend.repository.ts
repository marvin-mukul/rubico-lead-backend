import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/index.js';

/**
 * Spend aggregates over `api_usage`. All sums are computed in SQL — never by
 * loading rows into JS.
 *
 * Period boundaries are UTC. The caps in §6 are monthly/daily figures with no
 * timezone specified; UTC keeps them stable regardless of where this runs.
 */
@Injectable()
export class SpendRepository {
  constructor(private readonly prisma: PrismaService) {}

  static startOfMonthUtc(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  static startOfDayUtc(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /** Month-to-date spend for one provider (FR-C2). */
  async monthToDateUsd(provider: string, now?: Date): Promise<number> {
    const { _sum } = await this.prisma.apiUsage.aggregate({
      _sum: { usdCost: true },
      where: { provider, date: { gte: SpendRepository.startOfMonthUtc(now) } },
    });
    return _sum.usdCost ?? 0;
  }

  /** Month-to-date spend across every provider (health endpoint, §8.1). */
  async monthToDateTotalUsd(now?: Date): Promise<number> {
    const { _sum } = await this.prisma.apiUsage.aggregate({
      _sum: { usdCost: true },
      where: { date: { gte: SpendRepository.startOfMonthUtc(now) } },
    });
    return _sum.usdCost ?? 0;
  }

  /** Spend so far today, across every provider (FR-C3). */
  async todayUsd(now?: Date): Promise<number> {
    const { _sum } = await this.prisma.apiUsage.aggregate({
      _sum: { usdCost: true },
      where: { date: { gte: SpendRepository.startOfDayUtc(now) } },
    });
    return _sum.usdCost ?? 0;
  }

  /** Everything ever spent on one lead (FR-C4). */
  async leadSpendUsd(leadId: string): Promise<number> {
    const { _sum } = await this.prisma.apiUsage.aggregate({
      _sum: { usdCost: true },
      where: { leadId },
    });
    return _sum.usdCost ?? 0;
  }

  /** Per-provider MTD breakdown for GET /api/metrics/spend (§8.3). */
  async byProviderMonthToDate(now?: Date): Promise<Array<{ provider: string; usdCost: number }>> {
    const rows = await this.prisma.apiUsage.groupBy({
      by: ['provider'],
      _sum: { usdCost: true },
      where: { date: { gte: SpendRepository.startOfMonthUtc(now) } },
    });
    return rows.map((row) => ({ provider: row.provider, usdCost: row._sum.usdCost ?? 0 }));
  }
}

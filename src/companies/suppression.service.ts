import { Injectable, Logger } from '@nestjs/common';
import type { SuppressionReason } from '../common/domain/index.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../common/prisma/index.js';

/**
 * Suppression list (§5, `Company.suppressionReason`).
 *
 * A suppressed company is invisible to every downstream stage — enrichment,
 * classification, scoring, briefing and the digest. Use `activeFilter()` in
 * every query that feeds the pipeline rather than remembering the condition.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Spread into any `where` that must exclude suppressed companies. */
  static activeFilter(): Prisma.CompanyWhereInput {
    return { suppressionReason: null };
  }

  activeFilter(): Prisma.CompanyWhereInput {
    return SuppressionService.activeFilter();
  }

  async suppress(companyId: string, reason: SuppressionReason): Promise<void> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { suppressionReason: reason },
    });
    this.logger.log(`Suppressed company ${companyId} (${reason})`);
  }

  async unsuppress(companyId: string): Promise<void> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { suppressionReason: null },
    });
  }

  async isSuppressed(companyId: string): Promise<boolean> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { suppressionReason: true },
    });
    return company?.suppressionReason != null;
  }

  /** Filters a batch down to the companies the pipeline may act on. */
  async activeIds(companyIds: string[]): Promise<string[]> {
    if (companyIds.length === 0) return [];
    const rows = await this.prisma.company.findMany({
      where: { id: { in: companyIds }, ...SuppressionService.activeFilter() },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

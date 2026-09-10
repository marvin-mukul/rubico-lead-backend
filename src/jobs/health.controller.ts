import { Controller, Get } from '@nestjs/common';
import { InternalOnly } from '../common/auth/index.js';
import { SpendRepository } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';

/**
 * §8.1 — `GET /internal/health`.
 *
 * FR-B13 names this the fallback signal when alert delivery fails, which is
 * why month-to-date spend is exposed here rather than only over `/api/*`.
 */
@Controller('internal/health')
@InternalOnly()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spend: SpendRepository,
  ) {}

  @Get()
  async health(): Promise<{ status: string; db: boolean; mtdSpendUsd: number }> {
    const db = await this.prisma.isHealthy();
    const mtdSpendUsd = db ? await this.spend.monthToDateTotalUsd() : 0;
    return { status: db ? 'ok' : 'degraded', db, mtdSpendUsd };
  }
}

import { Injectable } from '@nestjs/common';
import { EVENT_SIGNAL_TYPES, type EventSignalType } from '../common/domain/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';

export interface CompoundResult {
  /** Points to add to the lead's score, already capped. */
  bonus: number;
  distinctTypes: number;
  types: EventSignalType[];
  windowDays: number;
}

/**
 * Compound detection: several *different kinds* of signal arriving for one
 * company inside a window is worth more than the same signal repeating.
 *
 * Only event signals (S1–S5) count. `F-LEG` is a standing property of the
 * company, re-verified weekly by `maintenance.reverify-legacy`, so counting it
 * would hand a permanent bonus to every legacy-stack company and stop the
 * bonus meaning "several things are happening at once".
 *
 * Config (all numeric, FR-SC3):
 *   compound.windowDays       how far back to look
 *   compound.minDistinctTypes how many kinds before any bonus at all
 *   compound.perExtraType     points per qualifying type
 *   compound.bonus            the cap (§12: "compound bonus caps at +10")
 */
@Injectable()
export class CompoundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ScoringConfigService,
  ) {}

  async evaluate(companyId: string, now: Date = new Date()): Promise<CompoundResult> {
    const windowDays = await this.config.get('compound.windowDays', 90);
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.signal.groupBy({
      by: ['type'],
      where: {
        companyId,
        eventDate: { gte: since, lte: now },
        type: { in: [...EVENT_SIGNAL_TYPES] },
      },
    });

    const types = rows
      .map((row) => row.type as EventSignalType)
      .sort((a, b) => a.localeCompare(b));

    return { ...(await this.bonusFor(types.length)), types, windowDays };
  }

  /** Split out so the arithmetic is testable without touching the database. */
  async bonusFor(distinctTypes: number): Promise<{ bonus: number; distinctTypes: number }> {
    const minDistinct = await this.config.get('compound.minDistinctTypes', 2);
    const perExtra = await this.config.get('compound.perExtraType', 5);
    const cap = await this.config.get('compound.bonus', 10);

    if (distinctTypes < minDistinct) return { bonus: 0, distinctTypes };

    const qualifying = distinctTypes - minDistinct + 1;
    return { bonus: Math.min(cap, qualifying * perExtra), distinctTypes };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { SIGNAL_TYPES, type SignalType } from '../common/domain/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import { CompoundService } from '../signals/index.js';
import { score, type ScorableSignal, type ScoreResult, type ScoringParameters } from './score.js';

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ScoringConfigService,
    private readonly compound: CompoundService,
  ) {}

  /** Reads every scoring knob out of `scoring_config` (FR-SC3). */
  async parameters(): Promise<ScoringParameters> {
    const weights: ScoringParameters['weights'] = {};
    for (const type of SIGNAL_TYPES) {
      weights[type] = {
        weight: await this.config.get(`${type}.weight`, 0),
        halfLifeDays: await this.config.get(`${type}.halfLifeDays`, 0),
      };
    }

    return {
      weights,
      fitWeight: await this.config.get('score.fitWeight', 1),
      intentWeight: await this.config.get('score.intentWeight', 1),
      bands: {
        immediate: await this.config.get('band.immediate.min', 70),
        high: await this.config.get('band.high.min', 50),
        investigate: await this.config.get('band.investigate.min', 30),
      },
      eventSignalFreshnessDays: await this.config.get('scoring.eventSignalFreshnessDays', 30),
    };
  }

  /** Scores one company without writing anything. */
  async scoreCompany(
    companyId: string,
    fitScore: number,
    now: Date = new Date(),
  ): Promise<ScoreResult> {
    const [params, rows, compound] = await Promise.all([
      this.parameters(),
      this.prisma.signal.findMany({
        where: { companyId },
        select: { id: true, type: true, eventDate: true },
      }),
      this.compound.evaluate(companyId, now),
    ]);

    const signals: ScorableSignal[] = rows.map((row) => ({
      id: row.id,
      type: row.type as SignalType,
      eventDate: row.eventDate,
    }));

    return score({ fitScore, signals, compoundBonus: compound.bonus, now }, params);
  }

  /** Scores a company and upserts its lead. */
  async upsertLead(companyId: string, fitScore: number, now: Date = new Date()): Promise<string> {
    const result = await this.scoreCompany(companyId, fitScore, now);

    const existing = await this.prisma.lead.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const data = {
      fitScore: result.fitScore,
      intentScore: result.intentScore,
      compoundBonus: result.compoundBonus,
      totalScore: result.totalScore,
      band: result.band,
      scoredAt: now,
    };

    if (existing) {
      await this.prisma.lead.update({ where: { id: existing.id }, data });
      return existing.id;
    }
    const created = await this.prisma.lead.create({ data: { companyId, ...data } });
    return created.id;
  }

  /**
   * Per-signal contributions with decay already applied, for
   * `GET /api/leads/:id` (FR-B16). The frontend renders these; it never
   * recomputes them.
   */
  async contributionsForLead(leadId: string): Promise<ScoreResult | null> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { companyId: true, fitScore: true, scoredAt: true },
    });
    if (!lead) return null;
    return this.scoreCompany(lead.companyId, lead.fitScore, lead.scoredAt);
  }
}

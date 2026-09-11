import { Injectable, Logger } from '@nestjs/common';
import { SIGNAL_TYPES, type SignalType } from '../common/domain/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import { CompoundService } from '../signals/index.js';
import { OpportunityConfigService } from '../opportunity/index.js';
import {
  score,
  type EvidenceStrength,
  type ScorableSignal,
  type ScoreResult,
  type ScoringParameters,
} from './score.js';

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ScoringConfigService,
    private readonly compound: CompoundService,
    private readonly opportunity: OpportunityConfigService,
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
      // Multipliers are numeric, so they live in scoring_config and a human
      // can PATCH them (FR-SC3). The ceilings are a mapping, so they live in
      // evidence.json (§2.3).
      evidenceMultipliers: {
        E0: await this.config.get('evidence.E0.multiplier', 0.25),
        E1: await this.config.get('evidence.E1.multiplier', 1),
        E2: await this.config.get('evidence.E2.multiplier', 1.5),
        E3: await this.config.get('evidence.E3.multiplier', 2),
        E4: await this.config.get('evidence.E4.multiplier', 2),
      },
      evidenceCeilings: this.opportunity.evidence.bandCeiling as ScoringParameters['evidenceCeilings'],
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
        select: { id: true, type: true, eventDate: true, evidenceStrength: true },
      }),
      this.compound.evaluate(companyId, now),
    ]);

    const signals: ScorableSignal[] = rows.map((row) => ({
      id: row.id,
      type: row.type as SignalType,
      eventDate: row.eventDate,
      evidenceStrength: (row.evidenceStrength ?? 'E0') as EvidenceStrength,
    }));

    return score({ fitScore, signals, compoundBonus: compound.bonus, now }, params);
  }

  /**
   * Scores a company and upserts its lead for one opportunity (P21).
   *
   * `opportunityKey` is what turns "one Lead per company" into "one Lead per
   * company per opportunity" (§2.4): the composite unique on
   * `(companyId, opportunityKey)` means a company already holding a
   * `fix_slowing_software` lead gets a SECOND row, not an overwrite, the
   * moment evidence for `ai_code_to_production` shows up. The scoring
   * arithmetic itself stays company-wide (P21 preserves it, per §7) — only
   * the archetype-carrying fields differ between a company's opportunities.
   */
  async upsertLead(
    companyId: string,
    opportunityKey: string,
    fitScore: number,
    now: Date = new Date(),
  ): Promise<{ id: string; isNew: boolean; hadBrief: boolean }> {
    const result = await this.scoreCompany(companyId, fitScore, now);

    const existing = await this.prisma.lead.findUnique({
      where: { companyId_opportunityKey: { companyId, opportunityKey } },
      select: { id: true, brief: true },
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
      return { id: existing.id, isNew: false, hadBrief: existing.brief !== null };
    }
    const created = await this.prisma.lead.create({
      data: { companyId, opportunityKey, ...data },
    });
    return { id: created.id, isNew: true, hadBrief: false };
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

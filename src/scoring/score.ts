import { isEventSignal, type LeadBand, type SignalType } from '../common/domain/index.js';
import { ageInDays, decay } from './decay.js';

/**
 * The scoring arithmetic. Pure functions, no Prisma import anywhere in this
 * file — FR-B16 puts the arithmetic in exactly one place, and this is it.
 */

export interface SignalWeight {
  weight: number;
  halfLifeDays: number;
}

export interface ScoringParameters {
  /** Per signal type. A type with no entry contributes nothing. */
  weights: Partial<Record<SignalType, SignalWeight>>;
  fitWeight: number;
  intentWeight: number;
  bands: { immediate: number; high: number; investigate: number };
  /** FR-SC4: an event signal must be at least this fresh, or band = ignore. */
  eventSignalFreshnessDays: number;
}

export interface ScorableSignal {
  id: string;
  type: SignalType;
  eventDate: Date;
}

export interface SignalContribution {
  signalId: string;
  type: SignalType;
  eventDate: Date;
  ageDays: number;
  baseWeight: number;
  halfLifeDays: number;
  /** Base weight with decay already applied (FR-B16). */
  contribution: number;
  /**
   * False for a signal beaten by a stronger one of the same type. Still
   * reported, so `GET /api/leads/:id` can show everything that was considered.
   */
  counted: boolean;
}

export interface ScoreResult {
  fitScore: number;
  intentScore: number;
  compoundBonus: number;
  totalScore: number;
  band: LeadBand;
  contributions: SignalContribution[];
  /** Set when the band was forced rather than derived from the total. */
  bandReason?: string;
}

export const MAX_SCORE = 100;

/**
 * Only the strongest surviving signal of each type counts toward intent.
 *
 * Parent spec §5 is not in this repo, so this is a decision rather than a
 * transcription, and it is worth stating. Summing every signal would let one
 * company posting fifty jobs outscore a company with funding, hiring and a
 * public pain signal — and it would make `F-LEG`, re-verified weekly, grow
 * without bound. Breadth is rewarded by the compound bonus instead, which is
 * exactly what compound detection is for.
 */
export function score(
  input: {
    fitScore: number;
    signals: ScorableSignal[];
    compoundBonus: number;
    now?: Date;
  },
  params: ScoringParameters,
): ScoreResult {
  const now = input.now ?? new Date();

  const contributions: SignalContribution[] = input.signals.map((signal) => {
    const configured = params.weights[signal.type];
    const baseWeight = configured?.weight ?? 0;
    const halfLifeDays = configured?.halfLifeDays ?? 0;
    const days = ageInDays(signal.eventDate, now);
    return {
      signalId: signal.id,
      type: signal.type,
      eventDate: signal.eventDate,
      ageDays: days,
      baseWeight,
      halfLifeDays,
      contribution: decay(baseWeight, halfLifeDays, days),
      counted: false,
    };
  });

  const strongestOfType = new Map<SignalType, SignalContribution>();
  for (const candidate of contributions) {
    const incumbent = strongestOfType.get(candidate.type);
    if (!incumbent || candidate.contribution > incumbent.contribution) {
      strongestOfType.set(candidate.type, candidate);
    }
  }
  for (const winner of strongestOfType.values()) winner.counted = true;

  const intentScore = [...strongestOfType.values()].reduce(
    (sum, entry) => sum + entry.contribution,
    0,
  );

  const rawTotal =
    input.fitScore * params.fitWeight + intentScore * params.intentWeight + input.compoundBonus;
  const totalScore = Math.max(0, Math.min(MAX_SCORE, Math.round(rawTotal)));

  // FR-SC4: no recent event signal means ignore, whatever the fit says. A
  // perfect-fit company with nothing happening is not a lead.
  const freshestEventAge = Math.min(
    ...contributions.filter((c) => isEventSignal(c.type)).map((c) => c.ageDays),
    Number.POSITIVE_INFINITY,
  );
  if (freshestEventAge > params.eventSignalFreshnessDays) {
    return {
      fitScore: input.fitScore,
      intentScore,
      compoundBonus: input.compoundBonus,
      totalScore,
      band: 'ignore',
      contributions,
      bandReason: `No event signal within ${params.eventSignalFreshnessDays} days (FR-SC4)`,
    };
  }

  return {
    fitScore: input.fitScore,
    intentScore,
    compoundBonus: input.compoundBonus,
    totalScore,
    band: bandFor(totalScore, params.bands),
    contributions,
  };
}

export function bandFor(total: number, bands: ScoringParameters['bands']): LeadBand {
  if (total >= bands.immediate) return 'immediate';
  if (total >= bands.high) return 'high';
  if (total >= bands.investigate) return 'investigate';
  return 'ignore';
}

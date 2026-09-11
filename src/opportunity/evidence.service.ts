import { Injectable } from '@nestjs/common';
import type { LeadBand } from '../common/domain/index.js';
import { OpportunityConfigService } from './opportunity-config.service.js';
import { EVIDENCE_LEVELS, type EvidenceLevel } from './opportunity-config.schemas.js';

/** Rank for comparison. Higher is stronger. */
const RANK: Record<EvidenceLevel, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

const BAND_RANK: Record<LeadBand, number> = {
  ignore: 0,
  investigate: 1,
  high: 2,
  immediate: 3,
};
const BAND_BY_RANK: LeadBand[] = ['ignore', 'investigate', 'high', 'immediate'];

export interface EvidenceInput {
  type: string;
  excerpt?: string | null;
  subject?: string | null;
}

/**
 * Evidence strength — how directly does this signal assert a technology
 * problem or an intent to buy?
 *
 *   E0 context · E1 inferred initiative · E2 stated initiative ·
 *   E3 declared requirement · E4 direct inbound
 *
 * Deliberately separate from **attribution confidence** (are we sure this is
 * the right company?). The `sec-edgar` failure was attributional — a real
 * funding event attached to the wrong company 12% of the time — and a single
 * axis cannot express "good evidence, wrong company". Attribution lands with
 * A14; this class is strength only.
 *
 * A text override can only RAISE a strength, never lower it. A tender that
 * happens not to match any phrase is still a tender.
 */
@Injectable()
export class EvidenceService {
  constructor(private readonly config: OpportunityConfigService) {}

  strengthOf(signal: EvidenceInput): EvidenceLevel {
    const base =
      (this.config.evidence.defaultBySignalType[signal.type] as EvidenceLevel | undefined) ?? 'E0';

    const text = [signal.subject, signal.excerpt].filter(Boolean).join(' ');
    if (!text) return base;

    let strongest = base;
    for (const override of this.config.evidenceOverrides) {
      const level = override.strength as EvidenceLevel;
      if (RANK[level] <= RANK[strongest]) continue;
      if (override.patterns.some((pattern) => pattern.test(text))) strongest = level;
    }
    return strongest;
  }

  /** The highest band this evidence may reach (§2.5.3 made mechanical). */
  ceilingFor(strength: EvidenceLevel): LeadBand {
    return (this.config.evidence.bandCeiling[strength] as LeadBand | undefined) ?? 'ignore';
  }

  /** Strongest of a set; `E0` when there is nothing. */
  strongest(levels: EvidenceLevel[]): EvidenceLevel {
    return levels.reduce<EvidenceLevel>(
      (best, level) => (RANK[level] > RANK[best] ? level : best),
      'E0',
    );
  }

  static rank(level: EvidenceLevel): number {
    return RANK[level] ?? 0;
  }

  static bandRank(band: LeadBand): number {
    return BAND_RANK[band] ?? 0;
  }

  static bandForRank(rank: number): LeadBand {
    return BAND_BY_RANK[Math.max(0, Math.min(3, rank))] ?? 'ignore';
  }

  /** Applies the ceiling: a band may be lowered by evidence, never raised. */
  static capBand(band: LeadBand, ceiling: LeadBand): LeadBand {
    return BAND_RANK[band] <= BAND_RANK[ceiling] ? band : ceiling;
  }

  static isLevel(value: string | null | undefined): value is EvidenceLevel {
    return Boolean(value) && (EVIDENCE_LEVELS as readonly string[]).includes(value as string);
  }
}

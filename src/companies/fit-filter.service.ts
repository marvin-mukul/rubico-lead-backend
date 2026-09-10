import { Injectable } from '@nestjs/common';
import { ScoringConfigService } from '../scoring-config/index.js';

/**
 * The fit filter (parent spec §4.1) — firmographic screening, before any
 * money is spent on a company.
 *
 * Every rule is config-driven: the thresholds and the points per attribute
 * live in `scoring_config` and change with no deploy (FR-SC3). Nothing about
 * the ICP is hard-coded here — this file only knows *how* to add points up,
 * never *which* attributes are desirable.
 *
 * `scoring_config.value` is a Float, so list-shaped rules ("allowed regions")
 * are modelled as one key per value: `fit.region.emea = 15`. An attribute with
 * no key scores `fit.<dimension>.default`, which is 0 unless configured.
 */

export interface FitInput {
  country?: string | null;
  region?: string | null;
  headcountBand?: string | null;
  industry?: string | null;
  atsProvider?: string | null;
  /** Truthy when homepage fingerprinting found legacy markers (F-LEG). */
  hasLegacyFlags?: boolean;
}

export interface FitContribution {
  /** The config key consulted, so a score is explainable (A3). */
  key: string;
  points: number;
}

export interface FitResult {
  fitScore: number;
  passes: boolean;
  minScore: number;
  contributions: FitContribution[];
}

const DIMENSIONS = ['headcount', 'region', 'country', 'industry'] as const;
const MAX_FIT_SCORE = 100;

/** `11-50 employees` → `11-50-employees`; keys stay predictable and greppable. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

@Injectable()
export class FitFilterService {
  constructor(private readonly config: ScoringConfigService) {}

  async evaluate(input: FitInput): Promise<FitResult> {
    const contributions: FitContribution[] = [];

    const values: Record<(typeof DIMENSIONS)[number], string | null | undefined> = {
      headcount: input.headcountBand,
      region: input.region,
      country: input.country,
      industry: input.industry,
    };

    for (const dimension of DIMENSIONS) {
      const raw = values[dimension];
      const key = raw
        ? `fit.${dimension}.${slugify(raw)}`
        : `fit.${dimension}.default`;

      // An unrecognised value is not the same as a missing one, but both fall
      // back to the dimension default rather than silently scoring zero.
      let points = await this.config.get(key, Number.NaN);
      if (Number.isNaN(points)) {
        points = await this.config.get(`fit.${dimension}.default`, 0);
        contributions.push({ key: `fit.${dimension}.default`, points });
        continue;
      }
      contributions.push({ key, points });
    }

    if (input.hasLegacyFlags) {
      contributions.push({
        key: 'fit.signal.legacyStack',
        points: await this.config.get('fit.signal.legacyStack', 0),
      });
    }
    if (input.atsProvider) {
      contributions.push({
        key: 'fit.signal.atsPresent',
        points: await this.config.get('fit.signal.atsPresent', 0),
      });
    }

    const raw = contributions.reduce((sum, c) => sum + c.points, 0);
    const fitScore = Math.max(0, Math.min(MAX_FIT_SCORE, Math.round(raw)));
    const minScore = await this.config.get('fit.minScore', 0);

    return { fitScore, passes: fitScore >= minScore, minScore, contributions };
  }
}

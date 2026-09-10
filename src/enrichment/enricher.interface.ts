import type { CompanyModel as Company } from '../generated/prisma/models.js';

/** Firmographics an enricher may discover. Only set what you actually know. */
export interface Firmographics {
  country?: string;
  region?: string;
  headcountBand?: string;
  industry?: string;
}

export interface EnrichmentResult {
  /** Modern stack markers, merged into `Company.detectedStack`. */
  detectedStack?: Record<string, unknown>;
  /** Legacy markers, merged into `Company.legacyFlags`. Drives F-LEG. */
  legacyFlags?: Record<string, unknown>;
  firmographics?: Firmographics;
  atsProvider?: string;
  atsSlug?: string;
}

/**
 * Seam 2 of the eight (§4). `cost` is declared rather than inferred so that a
 * Phase 1 paid enricher is visibly different at the registration site.
 */
export interface Enricher {
  readonly name: string;
  readonly cost: 'free' | 'metered';
  enrich(company: Company): Promise<EnrichmentResult>;
}

export const ENRICHER = Symbol('ENRICHER');

import { Injectable, Logger } from '@nestjs/common';
import type { CompanyModel as Company } from '../../generated/prisma/models.js';
import type { Enricher, EnrichmentResult } from '../enricher.interface.js';
import { fingerprint, isLegacy } from './fingerprint.js';

/** A slow homepage must not stall a pipeline run over hundreds of companies. */
const TIMEOUT_MS = 8_000;
/** Markers live in the head and early body; no need to read megabytes. */
const MAX_BYTES = 400_000;

@Injectable()
export class HomepageFingerprintEnricher implements Enricher {
  readonly name = 'homepage-fingerprint';
  readonly cost = 'free' as const;

  private readonly logger = new Logger(HomepageFingerprintEnricher.name);

  // Uses fetch directly rather than SourceHttpClient: the fingerprint needs
  // the response HEADERS (Server, X-Powered-By) as well as the body, and
  // SourceHttpClient deliberately exposes only the body.
  async enrich(company: Company): Promise<EnrichmentResult> {
    const url = `https://${company.canonicalDomain}/`;

    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'RubicoLeadEngine/0.1 (+mailto:marvin.mukul@rubicotech.in)' },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }

    const html = (await response.text()).slice(0, MAX_BYTES);
    const headers = Object.fromEntries(response.headers.entries());
    const result = fingerprint(html, headers);

    this.logger.debug(
      `${company.canonicalDomain}: modern=${Object.keys(result.modern).join(',') || '-'} ` +
        `legacy=${Object.keys(result.legacy).join(',') || '-'}`,
    );

    return {
      detectedStack: { ...result.modern, checkedAt: new Date().toISOString() },
      // Written even when empty, so a re-verification that finds nothing
      // clears a previous flag rather than leaving it stale (FR-S5).
      legacyFlags: isLegacy(result)
        ? { ...result.legacy, checkedAt: new Date().toISOString() }
        : {},
    };
  }
}

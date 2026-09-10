import { Injectable, Logger } from '@nestjs/common';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { DomainResolver } from './domain-resolver.interface.js';

interface Suggestion {
  name: string;
  domain: string;
}

/**
 * Opt-in name→domain resolution via Clearbit's free autocomplete endpoint
 * (no key, no billing — so it stays outside MeteredClient and outside the
 * "paid enrichment" that §14 excludes).
 *
 * Only accepts a match whose normalised name equals the query's, because the
 * endpoint is a prefix search: "Stripe" also returns StripersOnline and Stars
 * and Stripes. An exact-name rule is what keeps a wrong domain from being
 * attached to a company.
 *
 * Even so, this is heuristic. Legal entity names in SEC filings ("908
 * Preferred Investors I, LLC") rarely match a brand, so expect a low hit rate
 * rather than a wrong one.
 */
@Injectable()
export class ClearbitAutocompleteResolver implements DomainResolver {
  readonly name = 'clearbit';
  private readonly logger = new Logger(ClearbitAutocompleteResolver.name);
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly http: SourceHttpClient) {}

  async resolve(companyName: string): Promise<string | null> {
    const query = stripLegalSuffixes(companyName);
    if (query.length < 3) return null;

    const cached = this.cache.get(query);
    if (cached !== undefined) return cached;

    let resolved: string | null = null;
    try {
      const suggestions = await this.http.getJson<Suggestion[]>({
        url: `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`,
        minIntervalMs: 200,
        timeoutMs: 8_000,
        acceptMissing: true,
      });

      const wanted = normalise(query);
      resolved =
        suggestions?.find((s) => normalise(s.name) === wanted)?.domain?.toLowerCase() ?? null;
    } catch (error) {
      // A resolver failure must not fail ingestion — the record is simply
      // counted as unresolvable, exactly as with the null resolver.
      this.logger.warn(
        `Domain lookup failed for "${companyName}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.cache.set(query, resolved);
    return resolved;
  }
}

/** "Acme Holdings, LLC" → "Acme Holdings". */
export function stripLegalSuffixes(name: string): string {
  return name
    .replace(
      /[,]?\s+(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|limited|corp|corp\.|corporation|co|co\.|plc|lp|l\.p\.|llp|gmbh|bv|nv|sa|ag|pty|pte)\.?$/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

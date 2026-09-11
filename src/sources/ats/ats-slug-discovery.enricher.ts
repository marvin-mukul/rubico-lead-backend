import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/index.js';
import type { CompanyModel as Company } from '../../generated/prisma/models.js';
import type { Enricher, EnrichmentResult } from '../../enrichment/enricher.interface.js';
import { ATS_PROVIDER, type AtsProvider } from './ats-provider.interface.js';

/**
 * P26 — ATS slug discovery. `atsSlug` was read in eight places and written by
 * nothing (§1.9 of the broadening analysis): every tracked company today was
 * entered by hand. This closes that gap for companies already discovered by
 * some other source, by trying a small set of slug guesses derived from the
 * company's own name and domain against each ATS provider's public API.
 *
 * Deliberately excludes SmartRecruiters: its Postings API returns HTTP 200
 * with an empty result for ANY identifier, real or not (measured live
 * against six real and guessed company slugs) — there is no "not found"
 * signal to discover against, so guessing here would only produce false
 * matches. It stays fully usable via AtsSource once a slug is known some
 * other way; it is only unsuitable for blind discovery.
 *
 * Free (`cost: 'free'`): every provider probed is public and unauthenticated,
 * the same as `AtsSource` itself.
 */
@Injectable()
export class AtsSlugDiscoveryEnricher implements Enricher {
  readonly name = 'ats-slug-discovery';
  readonly cost = 'free' as const;

  private readonly logger = new Logger(AtsSlugDiscoveryEnricher.name);
  /** Providers whose API gives a trustworthy "this slug does not exist" signal. */
  private readonly discoverable: AtsProvider[];

  constructor(
    @Inject(ATS_PROVIDER) providers: AtsProvider[],
    private readonly prisma: PrismaService,
  ) {
    this.discoverable = providers.filter((provider) => provider.name !== 'smartrecruiters');
  }

  async enrich(company: Company): Promise<EnrichmentResult> {
    // Already known — by hand, or by a previous run. Never re-probe.
    if (company.atsProvider && company.atsSlug) return {};

    // An OBSERVED board beats a guessed one. `hackernews-hiring` records the
    // board a company linked to in its own job post, which is the only place
    // the engine ever sees a slug stated rather than probed for — it is
    // certain, it costs no request, and guessing can only do worse. Measured
    // on the September thread: 23 of 190 parsed companies arrive with one.
    const observed = await this.observedSlug(company.id);
    if (observed) {
      this.logger.log(
        `${company.canonicalDomain}: board observed in a job post — ${observed.provider}/${observed.slug}`,
      );
      return { atsProvider: observed.provider, atsSlug: observed.slug };
    }

    for (const slug of candidateSlugs(company)) {
      for (const provider of this.discoverable) {
        let postings;
        try {
          postings = await provider.listPostings(slug);
        } catch {
          // A transient failure here is not this company's problem; the
          // regular AtsSource ingestion will surface a persistently broken
          // provider via job failures, not silent enrichment.
          continue;
        }
        if (postings !== null) {
          this.logger.log(`${company.canonicalDomain}: found on ${provider.name}/${slug}`);
          return { atsProvider: provider.name, atsSlug: slug };
        }
      }
    }
    return {};
  }

  /** An ATS board this company linked to in one of its own signals. */
  private async observedSlug(
    companyId: string,
  ): Promise<{ provider: string; slug: string } | null> {
    const signals = await this.prisma.signal.findMany({
      where: { companyId, sourceName: 'hackernews-hiring' },
      orderBy: { eventDate: 'desc' },
      select: { raw: true },
      take: 5,
    });

    for (const signal of signals) {
      const ats = (signal.raw as { ats?: { provider?: unknown; slug?: unknown } } | null)?.ats;
      if (typeof ats?.provider === 'string' && typeof ats.slug === 'string') {
        // Only providers this engine can actually read back.
        if (this.discoverable.some((provider) => provider.name === ats.provider)) {
          return { provider: ats.provider, slug: ats.slug };
        }
      }
    }
    return null;
  }
}

/**
 * A small, deliberately bounded set of guesses — this runs against every
 * enricher call, across up to five providers, so it must not fan out
 * unboundedly. Two shapes cover most real boards: a lowercase-kebab slug
 * (Greenhouse/Lever/Ashby/Workable/Recruitee's usual house style) and the
 * company name with spaces removed but original casing kept (some Workable
 * and Recruitee tenants use their brand casing verbatim).
 */
export function candidateSlugs(company: Company): string[] {
  const domainLabel = company.canonicalDomain.split('.')[0] ?? '';
  const nameKebab = kebab(company.name);
  const namePacked = company.name.replace(/[^a-zA-Z0-9]/g, '');

  return [...new Set([kebab(domainLabel), nameKebab, namePacked].filter((slug) => slug.length > 1))];
}

const LEGAL_SUFFIXES =
  /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|group)\.?$/i;

function kebab(value: string): string {
  return value
    .replace(LEGAL_SUFFIXES, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

import type { CompanyModel as Company } from '../../generated/prisma/models.js';
import type { AtsPosting, AtsProvider } from './ats-provider.interface.js';
import { AtsSlugDiscoveryEnricher, candidateSlugs } from './ats-slug-discovery.enricher.js';

const company = (overrides: Partial<Company> = {}): Company =>
  ({
    id: 'c1',
    canonicalDomain: 'acme-corp.com',
    name: 'Acme Corp, Inc.',
    atsProvider: null,
    atsSlug: null,
    ...overrides,
  }) as Company;

describe('candidateSlugs', () => {
  it('derives a kebab-case slug from the domain label', () => {
    expect(candidateSlugs(company())).toContain('acme-corp');
  });

  it('strips legal suffixes from the company name', () => {
    const slugs = candidateSlugs(company({ name: 'Acme Corp, Inc.' }));
    expect(slugs).not.toContain('acme-corp-inc');
    expect(slugs).toContain('acme-corp');
  });

  it('includes a packed-case variant for SmartRecruiters/Workable-style identifiers', () => {
    expect(candidateSlugs(company({ name: 'Visa' }))).toContain('Visa');
  });

  it('deduplicates candidates that collapse to the same string', () => {
    const slugs = candidateSlugs(company({ canonicalDomain: 'acme.com', name: 'Acme' }));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

const posting: AtsPosting = {
  id: '1',
  title: 'Engineer',
  url: 'https://example.test/jobs/1',
  postedAt: new Date(),
};

function fakeProvider(name: AtsProvider['name'], matches: Record<string, AtsPosting[]>): AtsProvider {
  return {
    name,
    listPostings: async (slug: string) => matches[slug] ?? null,
  };
}

describe('AtsSlugDiscoveryEnricher', () => {
  it('never re-probes a company that already has a known ATS board', async () => {
    let called = false;
    const provider = fakeProvider('greenhouse', {});
    provider.listPostings = async () => {
      called = true;
      return null;
    };
    const enricher = new AtsSlugDiscoveryEnricher([provider]);

    const result = await enricher.enrich(
      company({ atsProvider: 'greenhouse', atsSlug: 'acme-corp' }),
    );

    expect(result).toEqual({});
    expect(called).toBe(false);
  });

  it('returns the provider and slug of the first match', async () => {
    const greenhouse = fakeProvider('greenhouse', {});
    const lever = fakeProvider('lever', { 'acme-corp': [posting] });
    const enricher = new AtsSlugDiscoveryEnricher([greenhouse, lever]);

    const result = await enricher.enrich(company());

    expect(result).toEqual({ atsProvider: 'lever', atsSlug: 'acme-corp' });
  });

  it('excludes smartrecruiters from discovery — its API cannot say "not found"', async () => {
    const smartrecruiters = fakeProvider('smartrecruiters', { 'acme-corp': [] });
    // Even though smartrecruiters "matches" every slug with an empty result,
    // discovery must never pick it — matching a real provider that finds
    // nothing is preferred over a fake match on an undiscoverable one.
    const enricher = new AtsSlugDiscoveryEnricher([smartrecruiters]);

    const result = await enricher.enrich(company());

    expect(result).toEqual({});
  });

  it('returns {} when no provider recognises any candidate slug', async () => {
    const provider = fakeProvider('greenhouse', {});
    const enricher = new AtsSlugDiscoveryEnricher([provider]);

    expect(await enricher.enrich(company())).toEqual({});
  });

  it('tolerates one provider throwing and still checks the rest', async () => {
    const broken = fakeProvider('greenhouse', {});
    broken.listPostings = async () => {
      throw new Error('network error');
    };
    const lever = fakeProvider('lever', { 'acme-corp': [posting] });
    const enricher = new AtsSlugDiscoveryEnricher([broken, lever]);

    const result = await enricher.enrich(company());

    expect(result).toEqual({ atsProvider: 'lever', atsSlug: 'acme-corp' });
  });
});

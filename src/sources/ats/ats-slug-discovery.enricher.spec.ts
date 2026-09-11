import type { PrismaService } from '../../common/prisma/index.js';
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

/**
 * A Prisma stand-in returning the signals a company has. These tests are
 * about slug GUESSING; the observed-slug path has its own cases below.
 */
const prismaWith = (signals: { raw: unknown }[] = []) =>
  ({ signal: { findMany: async () => signals } }) as unknown as PrismaService;

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
    const enricher = new AtsSlugDiscoveryEnricher([provider], prismaWith());

    const result = await enricher.enrich(
      company({ atsProvider: 'greenhouse', atsSlug: 'acme-corp' }),
    );

    expect(result).toEqual({});
    expect(called).toBe(false);
  });

  it('returns the provider and slug of the first match', async () => {
    const greenhouse = fakeProvider('greenhouse', {});
    const lever = fakeProvider('lever', { 'acme-corp': [posting] });
    const enricher = new AtsSlugDiscoveryEnricher([greenhouse, lever], prismaWith());

    const result = await enricher.enrich(company());

    expect(result).toEqual({ atsProvider: 'lever', atsSlug: 'acme-corp' });
  });

  it('excludes smartrecruiters from discovery — its API cannot say "not found"', async () => {
    const smartrecruiters = fakeProvider('smartrecruiters', { 'acme-corp': [] });
    // Even though smartrecruiters "matches" every slug with an empty result,
    // discovery must never pick it — matching a real provider that finds
    // nothing is preferred over a fake match on an undiscoverable one.
    const enricher = new AtsSlugDiscoveryEnricher([smartrecruiters], prismaWith());

    const result = await enricher.enrich(company());

    expect(result).toEqual({});
  });

  it('returns {} when no provider recognises any candidate slug', async () => {
    const provider = fakeProvider('greenhouse', {});
    const enricher = new AtsSlugDiscoveryEnricher([provider], prismaWith());

    expect(await enricher.enrich(company())).toEqual({});
  });

  it('tolerates one provider throwing and still checks the rest', async () => {
    const broken = fakeProvider('greenhouse', {});
    broken.listPostings = async () => {
      throw new Error('network error');
    };
    const lever = fakeProvider('lever', { 'acme-corp': [posting] });
    const enricher = new AtsSlugDiscoveryEnricher([broken, lever], prismaWith());

    const result = await enricher.enrich(company());

    expect(result).toEqual({ atsProvider: 'lever', atsSlug: 'acme-corp' });
  });
});

/**
 * An OBSERVED board beats a guessed one.
 *
 * `hackernews-hiring` records the board a company linked to in its own job
 * post. That is the only place the engine ever sees a slug stated rather than
 * probed for: it is certain, it costs no HTTP request, and a guess can only
 * do worse. Measured on the September 2026 thread, 23 of 190 parsed companies
 * arrive carrying one.
 */
describe('AtsSlugDiscoveryEnricher — observed boards', () => {
  const neverMatches: AtsProvider = {
    name: 'greenhouse',
    listPostings: async () => null,
  } as unknown as AtsProvider;

  const prismaWithSignals = (signals: { raw: unknown }[]) =>
    ({ signal: { findMany: async () => signals } }) as unknown as PrismaService;

  it('uses a board observed in a job post without probing anything', async () => {
    let probed = 0;
    const counting: AtsProvider = {
      name: 'ashby',
      listPostings: async () => {
        probed++;
        return null;
      },
    } as unknown as AtsProvider;

    const enricher = new AtsSlugDiscoveryEnricher(
      [counting],
      prismaWithSignals([{ raw: { ats: { provider: 'ashby', slug: 'close' } } }]),
    );

    expect(await enricher.enrich(company())).toEqual({
      atsProvider: 'ashby',
      atsSlug: 'close',
    });
    // The whole point: a stated slug needs no discovery request.
    expect(probed).toBe(0);
  });

  it('falls back to guessing when no board was observed', async () => {
    const enricher = new AtsSlugDiscoveryEnricher(
      [neverMatches],
      prismaWithSignals([{ raw: { ats: null } }]),
    );
    expect(await enricher.enrich(company())).toEqual({});
  });

  it('ignores an observed provider this engine cannot read back', async () => {
    // smartrecruiters is excluded from discovery because its API cannot say
    // "not found"; an observed one must not sneak in through the side door.
    const enricher = new AtsSlugDiscoveryEnricher(
      [neverMatches],
      prismaWithSignals([{ raw: { ats: { provider: 'smartrecruiters', slug: 'acme' } } }]),
    );
    expect(await enricher.enrich(company())).toEqual({});
  });

  it('ignores a malformed ats blob rather than writing rubbish', async () => {
    const enricher = new AtsSlugDiscoveryEnricher(
      [neverMatches],
      prismaWithSignals([{ raw: { ats: { provider: 'ashby' } } }, { raw: null }]),
    );
    expect(await enricher.enrich(company())).toEqual({});
  });

  it('never re-probes a company that already has a board', async () => {
    const enricher = new AtsSlugDiscoveryEnricher([neverMatches], prismaWithSignals([]));
    expect(
      await enricher.enrich(company({ atsProvider: 'lever', atsSlug: 'acme' })),
    ).toEqual({});
  });
});

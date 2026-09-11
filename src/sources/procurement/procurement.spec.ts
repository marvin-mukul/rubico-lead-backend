import { assessRelevance } from './procurement-relevance.js';
import { pickLanguage } from './procurement.providers.js';
import type { ProcurementNotice } from './procurement-provider.interface.js';
import { ProcurementSource } from './procurement.source.js';
import type { ProcurementProvider } from './procurement-provider.interface.js';

const notice = (overrides: Partial<ProcurementNotice> = {}): ProcurementNotice => ({
  id: 'n1',
  buyerName: 'Furze Down School',
  buyerEmail: 'procurement@furzedown.sch.uk',
  title: 'Managed IT Services Provision',
  publishedAt: new Date('2026-09-10T00:00:00Z'),
  noticeUrl: 'https://example.test/notice/1',
  ...overrides,
});

/**
 * Public procurement is mostly construction, catering and vehicles. This
 * filter is what stops the engine ingesting every roof repair in the country,
 * and it runs before anything is persisted or classified.
 */
describe('assessRelevance', () => {
  describe('by classification code', () => {
    it.each(['72000000', '72200000-7', '48000000', '48820000'])(
      'accepts CPV %s (IT services / software)',
      (code) => {
        expect(assessRelevance(notice({ title: 'Anything', classification: code })).relevant).toBe(
          true,
        );
      },
    );

    it.each(['D302', '70', 'D316'])('accepts US PSC %s', (code) => {
      expect(assessRelevance(notice({ title: 'Anything', classification: code })).relevant).toBe(
        true,
      );
    });

    it('rejects construction and refurbishment codes', () => {
      for (const code of ['45453100', '45000000', '15000000', '34100000']) {
        expect(
          assessRelevance(notice({ title: 'Kingsmoore Ward Refurbishment works', classification: code }))
            .relevant,
        ).toBe(false);
      }
    });
  });

  describe('by phrase, needed because codes are often generic', () => {
    it.each([
      'Provision of HR & MIS system',
      'Supply of a new website',
      'Digital transformation programme',
      'Mobile app for parents',
      'E-commerce platform replacement',
      'Case management system procurement',
      'Cloud migration services',
      'Application development partner',
    ])('accepts %s', (title) => {
      expect(assessRelevance(notice({ title, classification: '45000000' })).relevant).toBe(true);
    });

    // Bare words like "system" and "platform" are deliberately absent from
    // the vocabulary: they match a huge amount of civil engineering.
    it.each([
      'Kingsmoore Ward Refurbishment works',
      'Heating system replacement',
      'Drainage system maintenance',
      'Site Move, Furniture Removal and Recycling Services',
      'Supply of school meals',
      'Scaffolding platform hire',
      'Grounds maintenance',
    ])('rejects %s', (title) => {
      expect(assessRelevance(notice({ title, classification: '45000000' })).relevant).toBe(false);
    });
  });

  it('reports why it matched, so a signal can carry its justification', () => {
    expect(assessRelevance(notice({ classification: '72000000' })).reason).toContain('72000000');
    expect(
      assessRelevance(notice({ title: 'New website build', classification: '45000000' })).reason,
    ).toContain('website');
  });

  it('searches the description as well as the title', () => {
    const verdict = assessRelevance(
      notice({
        title: 'Framework Agreement Lot 3',
        description: 'Supply and support of a customer relationship management (CRM) solution.',
        classification: '45000000',
      }),
    );
    expect(verdict.relevant).toBe(true);
  });
});

/** TED returns most text as `{ eng: [...], fra: [...] }`. */
describe('pickLanguage', () => {
  it('passes a plain string through', () => {
    expect(pickLanguage('Ministry of Health')).toBe('Ministry of Health');
  });

  it('takes the first element of an array', () => {
    expect(pickLanguage(['Ministerie', 'Ministry'])).toBe('Ministerie');
  });

  it('prefers English when several languages are present', () => {
    expect(pickLanguage({ ces: ['Nemocnice'], eng: ['Hospital'], deu: ['Krankenhaus'] })).toBe(
      'Hospital',
    );
  });

  it('falls back to any language rather than dropping the buyer', () => {
    // A Czech hospital named in Czech is far better than no buyer at all.
    expect(pickLanguage({ ces: ['Fakultní nemocnice Ostrava'] })).toBe('Fakultní nemocnice Ostrava');
  });

  it('returns undefined for empty input', () => {
    expect(pickLanguage(undefined)).toBeUndefined();
    expect(pickLanguage({})).toBeUndefined();
  });
});

describe('ProcurementSource', () => {
  const provider = (name: ProcurementProvider['name'], notices: ProcurementNotice[]) =>
    ({ name, fetchSince: async () => notices }) satisfies ProcurementProvider;

  it('emits S6 signals carrying the buyer email as the domain', async () => {
    const source = new ProcurementSource([provider('uk-contracts-finder', [notice()])]);
    const [signal] = await source.fetch(new Date('2026-09-01'));

    expect(signal.type).toBe('S6');
    // Exact attribution: the domain comes from the notice itself, with no
    // name->domain resolution anywhere in this path.
    expect(signal.domain).toBe('procurement@furzedown.sch.uk');
    expect(signal.companyName).toBe('Furze Down School');
    expect(signal.sourceName).toBe('procurement:uk-contracts-finder');
    expect(signal.subject).toContain('Managed IT Services');
  });

  it('drops a notice with no contact email rather than guessing a domain', async () => {
    const source = new ProcurementSource([
      provider('ted-eu', [notice({ buyerEmail: undefined })]),
    ]);
    // An unattributable tender is the sec-edgar failure repeated; better to
    // drop it than to attach it to a guessed company.
    expect(await source.fetch(new Date('2026-09-01'))).toEqual([]);
  });

  it('drops notices that are not technology work', async () => {
    const source = new ProcurementSource([
      provider('uk-contracts-finder', [
        notice({ title: 'Kingsmoore Ward Refurbishment works', classification: '45453100' }),
      ]),
    ]);
    expect(await source.fetch(new Date('2026-09-01'))).toEqual([]);
  });

  it('includes the contract value in the excerpt when present', async () => {
    const source = new ProcurementSource([
      provider('uk-contracts-finder', [notice({ valueAmount: 92295.28, valueCurrency: 'GBP' })]),
    ]);
    const [signal] = await source.fetch(new Date('2026-09-01'));
    expect(signal.excerpt).toContain('GBP');
    expect(signal.excerpt).toContain('92,295');
  });

  it('keeps going when one feed is empty', async () => {
    const source = new ProcurementSource([
      provider('sam-gov', []),
      provider('ted-eu', [notice({ id: 'n2' })]),
    ]);
    expect(await source.fetch(new Date('2026-09-01'))).toHaveLength(1);
  });

  it('declares S6 as its only signal type', () => {
    expect(new ProcurementSource([]).signalTypes).toEqual(['S6']);
    expect(new ProcurementSource([]).name).toBe('procurement');
  });
});

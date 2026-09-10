import { dedupeHash, normaliseSubject, type DedupeIdentity } from './dedupe-hash.js';

const BASE: DedupeIdentity = {
  companyId: 'cmp_acme',
  type: 'S1',
  eventDate: new Date('2026-09-01T00:00:00.000Z'),
  subject: 'Series A',
};

/** §12: "Same round from four outlets produces one hash." */
describe('dedupeHash', () => {
  it('produces one hash for the same round reported by four outlets', () => {
    // The four differ only in who reported it and how they phrased it — the
    // fields the hash must ignore.
    const outlets: DedupeIdentity[] = [
      { ...BASE, subject: 'Series A' },
      { ...BASE, subject: 'series-a' },
      { ...BASE, subject: '  SERIES   A.  ' },
      { ...BASE, subject: 'Séries A' },
    ];

    const hashes = outlets.map(dedupeHash);
    expect(new Set(hashes).size).toBe(1);
  });

  it('ignores the time of day, bucketing on the UTC event date', () => {
    expect(dedupeHash({ ...BASE, eventDate: new Date('2026-09-01T23:59:59.999Z') })).toBe(
      dedupeHash({ ...BASE, eventDate: new Date('2026-09-01T00:00:00.000Z') }),
    );
  });

  // The other half of dedupe: genuinely different events must not collide.
  it('separates two different rounds for the same company', () => {
    expect(dedupeHash({ ...BASE, subject: 'Series A' })).not.toBe(
      dedupeHash({ ...BASE, subject: 'Series B' }),
    );
  });

  it('separates the same round on different days', () => {
    expect(dedupeHash(BASE)).not.toBe(
      dedupeHash({ ...BASE, eventDate: new Date('2026-09-02T00:00:00.000Z') }),
    );
  });

  it('separates different companies and different signal types', () => {
    expect(dedupeHash(BASE)).not.toBe(dedupeHash({ ...BASE, companyId: 'cmp_other' }));
    expect(dedupeHash(BASE)).not.toBe(dedupeHash({ ...BASE, type: 'S2' }));
  });

  it('cannot be collided by shifting the field boundaries', () => {
    // If the parts were concatenated without a separator, these two would
    // hash identically.
    const a = dedupeHash({ ...BASE, companyId: 'ab', subject: 'c' });
    const b = dedupeHash({ ...BASE, companyId: 'a', subject: 'bc' });
    expect(a).not.toBe(b);
  });

  it('is stable across calls and returns a sha256 hex digest', () => {
    expect(dedupeHash(BASE)).toBe(dedupeHash({ ...BASE }));
    expect(dedupeHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normaliseSubject', () => {
  it('strips case, accents, punctuation and extra whitespace', () => {
    expect(normaliseSubject('  Séries­ A!!  ')).toBe('series a');
    expect(normaliseSubject('Form D — $12M')).toBe('form d 12m');
  });

  it('leaves distinct subjects distinct', () => {
    expect(normaliseSubject('Series A')).not.toBe(normaliseSubject('Series B'));
  });
});

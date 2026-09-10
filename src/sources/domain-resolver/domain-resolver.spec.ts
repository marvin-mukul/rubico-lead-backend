import { stripLegalSuffixes } from './clearbit-autocomplete.resolver.js';
import { NullDomainResolver } from './null-domain.resolver.js';

describe('NullDomainResolver', () => {
  it('never resolves — the conservative default', async () => {
    expect(await new NullDomainResolver().resolve()).toBeNull();
  });
});

describe('stripLegalSuffixes', () => {
  it('drops the entity suffix so a brand name can match', () => {
    expect(stripLegalSuffixes('Airway Therapeutics, Inc.')).toBe('Airway Therapeutics');
    expect(stripLegalSuffixes('Acme Holdings LLC')).toBe('Acme Holdings');
    expect(stripLegalSuffixes('Beispiel GmbH')).toBe('Beispiel');
  });

  it('leaves a name with no suffix alone', () => {
    expect(stripLegalSuffixes('Stripe')).toBe('Stripe');
  });

  it('does not strip a word that merely ends in a suffix', () => {
    expect(stripLegalSuffixes('Lincoln')).toBe('Lincoln');
    expect(stripLegalSuffixes('Cisco')).toBe('Cisco');
  });
});

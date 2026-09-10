import { canonicalDomain, resolveCanonicalDomain } from './canonical-domain.js';

describe('resolveCanonicalDomain', () => {
  it('collapses four spellings of one company onto one domain', () => {
    const spellings = [
      'https://www.acme.com/careers?utm_source=hn',
      'ACME.com',
      'http://acme.com',
      'acme.com.',
    ];
    const resolved = spellings.map(canonicalDomain);
    expect(new Set(resolved).size).toBe(1);
    expect(resolved[0]).toBe('acme.com');
  });

  it('reduces subdomains to the registrable domain', () => {
    expect(canonicalDomain('careers.acme.com')).toBe('acme.com');
    expect(canonicalDomain('https://blog.eng.acme.com/post/1')).toBe('acme.com');
  });

  // The case the plan called out specifically.
  it('handles multi-part public suffixes', () => {
    expect(canonicalDomain('https://www.acme.co.uk/jobs')).toBe('acme.co.uk');
    expect(canonicalDomain('careers.acme.com.au')).toBe('acme.com.au');
    expect(canonicalDomain('acme.co.in')).toBe('acme.co.in');
  });

  it('strips credentials, ports, paths, queries and fragments', () => {
    expect(canonicalDomain('http://user:pw@shop.acme.com:8443/a/b?c=1#d')).toBe('acme.com');
  });

  it('accepts a bare email address', () => {
    expect(canonicalDomain('cto@acme.io')).toBe('acme.io');
  });

  it('rejects free-mail providers', () => {
    for (const input of ['someone@gmail.com', 'https://outlook.com', 'protonmail.com']) {
      expect(resolveCanonicalDomain(input)).toEqual({ domain: null, reason: 'free-mail' });
    }
  });

  it('rejects shared platforms that identify a page, not a company', () => {
    for (const input of [
      'https://acme.github.io/docs',
      'https://www.linkedin.com/company/acme',
      'https://boards.greenhouse.io/acme',
      'https://news.ycombinator.com/item?id=1',
    ]) {
      expect(resolveCanonicalDomain(input).reason).toBe('aggregator');
    }
  });

  it('rejects IP addresses', () => {
    expect(resolveCanonicalDomain('http://192.168.1.1/').reason).toBe('ip-address');
  });

  it('rejects empty and unparseable input', () => {
    expect(resolveCanonicalDomain('').reason).toBe('empty');
    expect(resolveCanonicalDomain('   ').reason).toBe('empty');
    expect(resolveCanonicalDomain(null).reason).toBe('empty');
    expect(resolveCanonicalDomain('not a domain at all').reason).toBe('unparseable');
    expect(resolveCanonicalDomain('localhost').reason).toBe('unparseable');
  });

  it('does not confuse similar domains', () => {
    expect(canonicalDomain('acme.com')).not.toBe(canonicalDomain('acme.co.uk'));
    expect(canonicalDomain('acme.com')).not.toBe(canonicalDomain('acme-inc.com'));
  });
});

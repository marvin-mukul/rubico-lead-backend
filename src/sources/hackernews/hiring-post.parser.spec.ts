import { atsFromUrl, parseHiringPost, toPlainText } from './hiring-post.parser.js';

/**
 * Every fixture below is a real comment shape from the September 2026
 * "Ask HN: Who is hiring?" thread, trimmed. The thread is a convention, not a
 * format, so the cases that matter are the ones that break it.
 */
describe('parseHiringPost', () => {
  it('reads the conventional Company | Location | REMOTE | url shape', () => {
    const post = parseHiringPost(
      'Catalyst Wayfare AI | Agent Builder | Remote (US ET Overlap) | Full-time | ' +
        '<a href="https://catalystwayfare.ai/careers">https://catalystwayfare.ai/careers</a> ' +
        'AI transformation firm shipping production AI systems for mid-market enterprises.',
    );

    expect(post?.domain).toBe('catalystwayfare.ai');
    expect(post?.companyName).toBe('Catalyst Wayfare AI');
    expect(post?.location).toContain('Remote (US ET Overlap)');
  });

  it('extracts an ATS board alongside the company domain', () => {
    const post = parseHiringPost(
      'Close | Remote (US) | https://close.com | Senior Backend Engineer | ' +
        'apply at https://jobs.ashbyhq.com/close/1234-abcd',
    );

    expect(post?.domain).toBe('close.com');
    // This is the only place the engine ever sees a slug STATED rather than
    // probed for — AtsSlugDiscoveryEnricher prefers it over a guess.
    expect(post?.ats).toEqual({ provider: 'ashby', slug: 'close' });
  });

  it('never attributes a post to the ATS host itself', () => {
    // A lead keyed on boards.greenhouse.io would merge every company that
    // uses Greenhouse into a single row.
    const post = parseHiringPost(
      'Acme | SF | https://boards.greenhouse.io/acme/jobs/42 and https://acme.dev',
    );
    expect(post?.domain).toBe('acme.dev');
    expect(post?.ats).toEqual({ provider: 'greenhouse', slug: 'acme' });
  });

  it('drops a post with no company domain rather than guessing one', () => {
    // Same discipline as procurement's "no contact email, no signal".
    expect(parseHiringPost('We are hiring a Rust engineer, email jobs@ our domain')).toBeNull();
    expect(parseHiringPost('Acme | NY | https://jobs.ashbyhq.com/acme/1')).toBeNull();
  });

  it('ignores profile, document and aggregator hosts', () => {
    expect(parseHiringPost('Someone | https://linkedin.com/in/someone')).toBeNull();
    // Caught live: a September post linked its JD on drive.google.com and was
    // attributed to Google.
    expect(parseHiringPost('Role | https://drive.google.com/file/d/abc')).toBeNull();
  });

  /**
   * Caught live: one September post links `https://🚀.anterior.app`, which
   * `URL` normalises to `xn--xp5a.anterior.app`. Keyed as-is that is a
   * different company from `anterior.app`, and the two never merge.
   */
  it('strips punycode labels so an emoji subdomain is not its own company', () => {
    const post = parseHiringPost('Anterior | NY | https://xn--xp5a.anterior.app/careers');
    expect(post?.domain).toBe('anterior.app');
  });

  it('falls back to the domain when the first segment is a job title', () => {
    // "Director of Sales" is not a company, and naming one that is worse than
    // naming it after its own domain.
    const post = parseHiringPost('Director of Sales\nLegal Ark AI | https://legalark.ai');
    expect(post?.companyName).toBe('legalark');
  });

  it('strips an inline URL out of the company name', () => {
    const post = parseHiringPost('Freeform ( https://freeform.co ) | Software Engineers');
    expect(post?.companyName).toBe('Freeform');
  });

  it('keeps enough of the post for the classifier to read the stack', () => {
    const post = parseHiringPost(
      'Acme | SF | https://acme.dev | We are on a Rails 4 monolith we cannot upgrade ' +
        'and a React 15 frontend, and need help getting off both.',
    );
    expect(post?.excerpt).toContain('Rails 4 monolith');
    expect(post?.excerpt).toContain('React 15');
  });
});

describe('atsFromUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/42', 'greenhouse', 'acme'],
    ['https://jobs.lever.co/acme/abc-def', 'lever', 'acme'],
    ['https://jobs.ashbyhq.com/acme/1234', 'ashby', 'acme'],
    // Workable and Recruitee put the tenant in the SUBDOMAIN, not the path.
    ['https://acme.workable.com/j/ABC123', 'workable', 'acme'],
    ['https://acme.recruitee.com/o/engineer', 'recruitee', 'acme'],
  ])('reads %s', (url, provider, slug) => {
    expect(atsFromUrl(url)).toEqual({ provider, slug });
  });

  it('returns null for a non-ATS url', () => {
    expect(atsFromUrl('https://acme.dev/careers')).toBeNull();
  });

  it('rejects a path segment that is a route, not a tenant', () => {
    expect(atsFromUrl('https://boards.greenhouse.io/embed/job_board?for=acme')).toBeNull();
  });
});

describe('toPlainText', () => {
  it('turns HN comment HTML into readable text', () => {
    expect(toPlainText('<p>Acme &amp; Co</p><p>We use Rails &lt;5</p>')).toContain('Acme & Co');
    expect(toPlainText('<p>line one</p><p>line two</p>')).toContain('line two');
  });
});

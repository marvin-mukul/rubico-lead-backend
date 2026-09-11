/**
 * A press release names a company; it very rarely gives you that company's
 * domain directly. Rather than guess from the name (the `sec-edgar` failure:
 * ~12% resolution, at least one measured wrong match, and a wrong domain
 * silently merges two real companies with no way to notice — A14), this
 * extracts a domain ONLY when the release's own text names one, in the
 * boilerplate "For more information, visit www.company.com" pattern every
 * wire release carries. No domain in the text means no signal — the same
 * honest default as `SEC_DOMAIN_RESOLVER=none`.
 *
 * Requires an explicit scheme or a `www.` prefix, deliberately: a bare
 * dotted word ("U.S. Inc.", "Sept. 11") is not evidence of a URL, but nobody
 * writes "www.acme.com" or "https://acme.com" by accident.
 */

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
/** At least two dot-separated labels — a bare label alone is never a domain. */
const DOMAIN_BODY = `(?:${LABEL}\\.)+${LABEL}`;

// The literal scheme / `www.` prefix is what anchors these to an actual URL
// mention rather than ordinary dotted text ("U.S.", "Q3.2026") — see the
// abbreviation test in the spec.
const SCHEME_PATTERN = new RegExp(`\\bhttps?:\\/\\/(?:www\\.)?(${DOMAIN_BODY})\\b`, 'gi');
const WWW_PATTERN = new RegExp(`\\bwww\\.(${DOMAIN_BODY})\\b`, 'gi');

/** The wire services themselves, plus generic destinations a release links to that are never the subject company. */
const NON_COMPANY_HOSTS = new Set([
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'sec.gov',
  'nasdaq.com',
  'nyse.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'youtube.com',
  'instagram.com',
]);

export function extractCompanyDomain(text: string): string | null {
  for (const pattern of [SCHEME_PATTERN, WWW_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const host = match[1]?.toLowerCase();
      if (host && !isNonCompanyHost(host)) return host;
    }
  }
  return null;
}

function isNonCompanyHost(host: string): boolean {
  for (const blocked of NON_COMPANY_HOSTS) {
    if (host === blocked || host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

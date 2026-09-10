import { parse } from 'tldts';

/**
 * Canonical domain resolution — the identity key for a Company (§5,
 * `canonicalDomain @unique`). Dedupe is that uniqueness, so everything hinges
 * on four spellings of one company collapsing to one string here.
 *
 * Pure function: no I/O, no database.
 */

/** Mailbox providers — never a company's canonical domain. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de',
  'mail.com', 'mail.ru', 'yandex.ru', 'yandex.com', 'zoho.com', 'fastmail.com',
  'hey.com', 'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com',
]);

/**
 * Shared platforms. A page here identifies a *page*, not a company, and the
 * registrable domain would collapse every tenant onto one row.
 */
const AGGREGATORS = new Set([
  'github.io', 'github.com', 'gitlab.io', 'gitlab.com', 'bitbucket.io',
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'wixsite.com',
  'squarespace.com', 'webflow.io', 'netlify.app', 'vercel.app', 'herokuapp.com',
  'pages.dev', 'notion.site', 'crunchbase.com', 'producthunt.com',
  'ycombinator.com', 'news.ycombinator.com', 'sec.gov', 'angel.co', 'wellfound.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'bamboohr.com',
  'glassdoor.com', 'indeed.com', 'youtube.com', 'google.com', 'apple.com',
  'amazonaws.com', 'azurewebsites.net', 'sites.google.com', 'firebaseapp.com',
]);

export type RejectionReason =
  | 'empty'
  | 'unparseable'
  | 'ip-address'
  | 'free-mail'
  | 'aggregator';

export interface CanonicalDomainResult {
  domain: string | null;
  reason?: RejectionReason;
}

/**
 * Returns the registrable domain, or null with a reason.
 *
 * Handles: scheme, credentials, port, path/query/fragment, `www.`, casing,
 * trailing dots, bare email addresses, and multi-part public suffixes
 * (`acme.co.uk` is the registrable domain; `co.uk` is not).
 */
export function resolveCanonicalDomain(input: string | null | undefined): CanonicalDomainResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { domain: null, reason: 'empty' };

  // `parse` accepts URLs, hostnames and emails, but not a bare "user:pw@host"
  // without a scheme, so hand it something it always understands.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const parsed = parse(withScheme, { allowPrivateDomains: false });

  if (parsed.isIp) return { domain: null, reason: 'ip-address' };
  if (!parsed.domain || !parsed.publicSuffix) return { domain: null, reason: 'unparseable' };

  const domain = parsed.domain.toLowerCase().replace(/\.$/, '');

  if (FREE_MAIL.has(domain)) return { domain: null, reason: 'free-mail' };
  if (AGGREGATORS.has(domain)) return { domain: null, reason: 'aggregator' };

  return { domain };
}

/** Convenience wrapper for callers that only care whether it resolved. */
export function canonicalDomain(input: string | null | undefined): string | null {
  return resolveCanonicalDomain(input).domain;
}

/** Exposed for tests and for the fit filter's "is this a real company" check. */
export const KNOWN_FREE_MAIL_DOMAINS: ReadonlySet<string> = FREE_MAIL;
export const KNOWN_AGGREGATOR_DOMAINS: ReadonlySet<string> = AGGREGATORS;

/**
 * Parses one top-level comment from an "Ask HN: Who is hiring?" thread.
 *
 * Why this source exists: the engine had exactly one high-volume discovery
 * source, EU procurement, which finds European public bodies. This thread is
 * the opposite — a few hundred mostly-US software companies per month, each
 * describing in plain English what they are building, what stack they are on
 * and what they cannot hire fast enough to fix. That is Rubico's buying
 * signal stated by the buyer.
 *
 * Measured against the September 2026 thread (256 top-level posts): 194 carry
 * a resolvable company domain (76%) and 47 link directly to an ATS board.
 *
 * The convention is `Company | Location | REMOTE | role | url`, but it is a
 * convention and not a format — roughly a quarter of posts break it. Every
 * rule below is therefore a best effort that fails to `null` rather than
 * guessing, on the same principle as procurement's "no contact email, no
 * signal": a post we cannot attribute to a domain is not a lead, it is noise
 * with a company name attached.
 */

/** Boards whose URL names an ATS tenant rather than the company's own site. */
const ATS_HOSTS: readonly { host: string; provider: string }[] = [
  { host: 'greenhouse.io', provider: 'greenhouse' },
  { host: 'lever.co', provider: 'lever' },
  { host: 'ashbyhq.com', provider: 'ashby' },
  { host: 'workable.com', provider: 'workable' },
  { host: 'smartrecruiters.com', provider: 'smartrecruiters' },
  { host: 'recruitee.com', provider: 'recruitee' },
];

/**
 * Hosts that identify a person, a document or a social profile — never the
 * hiring company's own domain. Treating `linkedin.com/in/someone` as the
 * company would attribute every such post to LinkedIn.
 */
const NOT_A_COMPANY: readonly string[] = [
  'linkedin.com',
  'twitter.com',
  'x.com',
  'github.com',
  'gitlab.com',
  'notion.so',
  'notion.site',
  // All of Google's document and drive hosts, not just docs — a post linking
  // its JD on `drive.google.com` would otherwise be attributed to Google.
  'google.com',
  'forms.gle',
  'airtable.com',
  'ycombinator.com',
  'news.ycombinator.com',
  'wellfound.com',
  'angel.co',
  'indeed.com',
  'glassdoor.com',
  'youtube.com',
  'calendly.com',
  'medium.com',
  'substack.com',
];

export interface HiringPost {
  /** The company's own domain — the thing the engine keys a Company on. */
  domain: string;
  companyName: string;
  /** The location segment as written, e.g. "NY, USA | REMOTE". */
  location: string | null;
  /** Present when the post linked straight to a job board. */
  ats: { provider: string; slug: string } | null;
  /** The post itself — the classifier's actual input. */
  excerpt: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/** HN comments arrive as HTML fragments. */
export function toPlainText(commentHtml: string): string {
  return commentHtml
    .replace(/<\s*\/?\s*p\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function hostOf(url: string): string | null {
  let host: string;
  try {
    // Trailing punctuation is extremely common — "see https://acme.com."
    host = new URL(url.replace(/[.,;:)]+$/, '')).hostname.toLowerCase();
  } catch {
    return null;
  }

  host = host.replace(/^www\./, '');

  /**
   * Drop punycode labels.
   *
   * Emoji subdomains are a real fashion in this thread — one September post
   * links `https://🚀.anterior.app`, which `URL` normalises to
   * `xn--xp5a.anterior.app`. Keyed on as-is, that is a different company from
   * `anterior.app`, and the two would never merge.
   */
  const labels = host.split('.').filter((label) => !label.startsWith('xn--'));
  return labels.length >= 2 ? labels.join('.') : host;
}

/** `https://jobs.ashbyhq.com/acme/some-role` -> `{ ashby, acme }`. */
export function atsFromUrl(url: string): { provider: string; slug: string } | null {
  const host = hostOf(url);
  if (!host) return null;

  const match = ATS_HOSTS.find((candidate) => host.endsWith(candidate.host));
  if (!match) return null;

  let path: string;
  try {
    path = new URL(url.replace(/[.,;:)]+$/, '')).pathname;
  } catch {
    return null;
  }

  // Greenhouse and Lever put the tenant first in the path
  // (boards.greenhouse.io/acme); Workable and Recruitee put it in the
  // subdomain (acme.workable.com). Ashby and SmartRecruiters use the path.
  const fromPath = path.split('/').filter(Boolean)[0];
  const fromSubdomain = host.slice(0, host.length - match.host.length).replace(/\.$/, '');

  const slug =
    match.provider === 'workable' || match.provider === 'recruitee' ?
      (fromSubdomain || fromPath)
    : (fromPath ?? fromSubdomain);

  if (!slug || slug === 'www' || slug.length > 80) return null;
  // Greenhouse embed URLs look like `/embed/job_board?for=acme`.
  if (slug === 'embed' || slug === 'jobs' || slug === 'careers') return null;

  return { provider: match.provider, slug: slug.toLowerCase() };
}

/**
 * The company's own domain, or null.
 *
 * Deliberately refuses ATS and profile hosts rather than falling back to
 * them: a lead attributed to `boards.greenhouse.io` is worse than no lead,
 * because it merges every company that uses Greenhouse into one row.
 */
function companyDomain(urls: readonly string[]): string | null {
  for (const url of urls) {
    const host = hostOf(url);
    if (!host) continue;
    if (ATS_HOSTS.some((candidate) => host.endsWith(candidate.host))) continue;
    if (NOT_A_COMPANY.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
      continue;
    }
    if (!host.includes('.')) continue;
    return host;
  }
  return null;
}

/**
 * The name, from the conventional first pipe-segment.
 *
 * Falls back to the domain rather than to a truncated sentence: posts that
 * ignore the convention usually open with a role title ("Director of
 * Sales"), and a company called "Director of Sales" is worse than one named
 * after its own domain.
 */
function companyName(text: string, domain: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  const candidate = (firstLine.split('|')[0] ?? '')
    // Strip an inline URL: "Freeform ( http://freeform.co )".
    .replace(URL_PATTERN, '')
    .replace(/[(){}[\]·|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const looksLikeARole =
    /\b(engineer|developer|designer|manager|director|lead|head of|senior|staff|principal|intern|scientist|analyst)\b/i.test(
      candidate,
    );

  if (candidate.length >= 2 && candidate.length <= 60 && !looksLikeARole) return candidate;
  return domain.split('.')[0] ?? domain;
}

/** The pipe-separated segments after the name, where location conventionally sits. */
function location(text: string): string | null {
  const firstLine = text.split('\n')[0] ?? '';
  const segments = firstLine
    .split('|')
    .slice(1, 4)
    .map((segment) => segment.replace(URL_PATTERN, '').trim())
    .filter((segment) => segment.length > 0 && segment.length <= 60);

  return segments.length > 0 ? segments.join(' | ') : null;
}

export function parseHiringPost(commentHtml: string): HiringPost | null {
  const text = toPlainText(commentHtml);
  if (text.length < 20) return null;

  const urls = text.match(URL_PATTERN) ?? [];
  const domain = companyDomain(urls);
  // No domain, no signal. See the file comment.
  if (!domain) return null;

  const atsUrl = urls.find((url) => atsFromUrl(url) !== null);

  return {
    domain,
    companyName: companyName(text, domain),
    location: location(text),
    ats: atsUrl ? atsFromUrl(atsUrl) : null,
    // Generous, because this is what the classifier reads to decide whether
    // there is a Rubico opportunity. The stack and the pain are usually
    // several sentences in.
    excerpt: text.slice(0, 1200),
  };
}

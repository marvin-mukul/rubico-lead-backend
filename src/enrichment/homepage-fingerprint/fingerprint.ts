/**
 * Homepage stack fingerprinting — pure functions over HTML and headers.
 *
 * No I/O here so the rules are testable without the network, which matters:
 * these markers decide `F-LEG`, and a silent regression would quietly stop
 * the engine finding the companies it exists to find.
 */

export interface Fingerprint {
  modern: Record<string, true>;
  legacy: Record<string, true>;
}

interface Rule {
  key: string;
  /** Matched against the HTML body. */
  html?: RegExp;
  /** Matched against `name: value` header lines, lowercased. */
  header?: RegExp;
}

const MODERN_RULES: Rule[] = [
  { key: 'react', html: /data-reactroot|__REACT_DEVTOOLS|\/_next\/static|react(?:-dom)?[.@-][\d.]+/i },
  { key: 'nextjs', html: /__NEXT_DATA__|\/_next\/static/i },
  { key: 'vue', html: /data-v-[0-9a-f]{8}|__VUE__|vue(?:\.runtime)?[.@-][\d.]+/i },
  { key: 'nuxt', html: /__NUXT__|\/_nuxt\//i },
  { key: 'svelte', html: /svelte-[0-9a-z]{6}|\/_app\/immutable\//i },
  { key: 'angular', html: /ng-version="(1[3-9]|[2-9]\d)/i },
  { key: 'tailwind', html: /tailwind|(?:^|["\s])(?:flex|grid)\s+(?:items-center|justify-between)/i },
  { key: 'vite', html: /\/assets\/index-[0-9a-z]{8}\.js/i },
  { key: 'cdn-modern', header: /^server:\s*(vercel|netlify|cloudflare)/i },
];

const LEGACY_RULES: Rule[] = [
  // ASP.NET Web Forms — a __VIEWSTATE field is unambiguous.
  { key: 'aspnet-webforms', html: /__VIEWSTATE|__EVENTVALIDATION|\.aspx["'?]/i },
  { key: 'aspnet', header: /^x-(?:aspnet-version|powered-by):\s*asp\.net/i },
  // jQuery 1.x/2.x specifically; 3.x is still current enough not to flag.
  { key: 'jquery-old', html: /jquery[.\-/@]?(?:-|v)?[12]\.\d+(?:\.\d+)?(?:\.min)?\.js/i },
  { key: 'php-legacy', header: /^x-powered-by:\s*php\/[45]\./i },
  { key: 'wordpress', html: /\/wp-content\/|\/wp-includes\//i },
  { key: 'drupal-old', html: /drupal\.settings|sites\/all\/(?:modules|themes)/i },
  { key: 'angularjs', html: /angular(?:\.min)?\.js|ng-app=|angular[.@-]1\.\d/i },
  { key: 'bootstrap-old', html: /bootstrap[.\-/@]?(?:-|v)?[23]\.\d+(?:\.\d+)?(?:\.min)?\.css/i },
  { key: 'table-layout', html: /<table[^>]+(?:width="100%"[^>]*)?(?:cellpadding|cellspacing)=/i },
  { key: 'document-write', html: /document\.write\s*\(/i },
  { key: 'flash', html: /\.swf["'?]|application\/x-shockwave-flash/i },
  { key: 'frames', html: /<frameset|<iframe[^>]+name="main"/i },
  { key: 'old-apache', header: /^server:\s*apache\/2\.[0-2]\./i },
  { key: 'old-iis', header: /^server:\s*microsoft-iis\/[1-7]\./i },
  { key: 'jsp', html: /\.jsp["'?]|jsessionid/i },
  { key: 'coldfusion', html: /\.cfm["'?]|cfid=/i },
];

function applyRules(rules: Rule[], html: string, headerLines: string[]): Record<string, true> {
  const found: Record<string, true> = {};
  for (const rule of rules) {
    if (rule.html?.test(html)) found[rule.key] = true;
    if (rule.header && headerLines.some((line) => rule.header!.test(line))) found[rule.key] = true;
  }
  return found;
}

export function fingerprint(html: string, headers: Record<string, string> = {}): Fingerprint {
  const headerLines = Object.entries(headers).map(
    ([name, value]) => `${name.toLowerCase()}: ${String(value).toLowerCase()}`,
  );
  return {
    modern: applyRules(MODERN_RULES, html, headerLines),
    legacy: applyRules(LEGACY_RULES, html, headerLines),
  };
}

/**
 * A site is flagged legacy on legacy evidence alone. A modern marker does not
 * cancel it out: a React front end bolted onto an ASP.NET Web Forms back end
 * is precisely the modernisation lead this engine is looking for.
 */
export function isLegacy(result: Fingerprint): boolean {
  return Object.keys(result.legacy).length > 0;
}

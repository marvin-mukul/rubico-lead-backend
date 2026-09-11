/**
 * Homepage stack fingerprinting — pure functions over HTML and headers.
 *
 * No I/O here so the rules are testable without the network, which matters:
 * these markers decide `F-LEG` and `F-PLAT`, and a silent regression would
 * quietly stop the engine finding the companies it exists to find — or, worse,
 * make it pitch a rebuild to someone who does not need one.
 *
 * THREE buckets, and the distinction between the last two is the whole point:
 *
 *   modern   — current tooling. Context only.
 *   platform — a platform Rubico SELLS work on (WordPress, WooCommerce,
 *              Shopify, Magento 2, Laravel). A capability MATCH and an
 *              opportunity input. NEVER a defect.
 *   legacy   — genuinely obsolete and rebuild-worthy. Supports a
 *              modernisation pitch.
 *
 * Magento is the case that proves these rules need version awareness rather
 * than presence detection: Magento 1.x has been end-of-life since June 2020
 * and is a real modernisation lead, while Magento 2 is a current platform
 * Rubico staffs for. Same product, opposite meaning, decided by version.
 */

export interface Fingerprint {
  modern: Record<string, true>;
  /** Rubico-serviced platforms. A capability match, not a problem. */
  platform: Record<string, true>;
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

/**
 * Platforms Rubico sells work on (verified capability map: WordPress,
 * WooCommerce, Shopify, Magento/Adobe Commerce, Laravel, current Angular).
 *
 * Detecting one of these is a REASON TO ENGAGE, not a problem to fix. A
 * company on WooCommerce is a company whose stack Rubico already staffs for.
 */
const PLATFORM_RULES: Rule[] = [
  { key: 'wordpress', html: /\/wp-content\/|\/wp-includes\/|wp-json/i },
  // Technical markers only — NEVER the bare brand name. Matching the word
  // "woocommerce" flagged stripe.com, whose homepage merely advertises a
  // WooCommerce integration. Any agency or SaaS listing supported platforms
  // would misfire the same way, Rubico's own site included.
  {
    key: 'woocommerce',
    html: /\/plugins\/woocommerce\/|wc-add-to-cart|woocommerce-page|wc_add_to_cart_params|class="[^"]*\bwoocommerce\b/i,
  },
  { key: 'shopify', html: /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i },
  // Magento 2 — current, supported.
  { key: 'magento2', html: /\/static\/version\d+|data-mage-init|Magento_Ui|\/pub\/static\/frontend/i },
  { key: 'laravel', header: /set-cookie:[^\n]*laravel_session/i },
  { key: 'laravel', html: /\/vendor\/laravel|laravel-vapor/i },
  { key: 'drupal-current', html: /drupal-settings-json|\/core\/misc\/drupal\.js/i },
];

const LEGACY_RULES: Rule[] = [
  // ASP.NET Web Forms — a __VIEWSTATE field is unambiguous.
  { key: 'aspnet-webforms', html: /__VIEWSTATE|__EVENTVALIDATION|\.aspx["'?]/i },
  { key: 'aspnet', header: /^x-(?:aspnet-version|powered-by):\s*asp\.net/i },
  // jQuery 1.x/2.x specifically; 3.x is still current enough not to flag.
  { key: 'jquery-old', html: /jquery[.\-/@]?(?:-|v)?[12]\.\d+(?:\.\d+)?(?:\.min)?\.js/i },
  { key: 'php-legacy', header: /^x-powered-by:\s*php\/[45]\./i },
  // Magento 1.x — end of life since June 2020. The counterpart to magento2
  // above, and the reason these rules are version-aware.
  { key: 'magento1', html: /\/skin\/frontend\/|\/js\/mage\/|Mage\.Cookies|varien\/js/i },
  // Drupal 7 and earlier. `drupal-current` above covers 8+.
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

  const platform = applyRules(PLATFORM_RULES, html, headerLines);
  const legacy = applyRules(LEGACY_RULES, html, headerLines);

  // A Magento 2 storefront still ships plenty of `/js/mage/` paths, so the
  // magento1 rule can fire alongside magento2. When both match, the current
  // version wins — a live Magento 2 store is not a Magento 1 rebuild lead.
  if (platform.magento2) delete legacy.magento1;
  // Likewise Drupal 8+ retains some Drupal 7-era paths.
  if (platform['drupal-current']) delete legacy['drupal-old'];

  return { modern: applyRules(MODERN_RULES, html, headerLines), platform, legacy };
}

/**
 * A site is flagged legacy on legacy evidence alone. A modern marker does not
 * cancel it out: a React front end bolted onto an ASP.NET Web Forms back end
 * is precisely the modernisation lead this engine is looking for.
 *
 * A PLATFORM marker does not cancel it either, and does not create it. The
 * two are independent facts: a WooCommerce store running jQuery 1.x is both a
 * capability match and a modernisation lead.
 */
export function isLegacy(result: Fingerprint): boolean {
  return Object.keys(result.legacy).length > 0;
}

/** True when the site runs on a platform Rubico sells work on. */
export function isServicedPlatform(result: Fingerprint): boolean {
  return Object.keys(result.platform).length > 0;
}

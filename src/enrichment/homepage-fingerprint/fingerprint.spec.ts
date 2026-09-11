import { fingerprint, isLegacy, isServicedPlatform } from './fingerprint.js';

describe('fingerprint — legacy markers', () => {
  it('flags ASP.NET Web Forms from a __VIEWSTATE field', () => {
    const result = fingerprint('<form><input type="hidden" name="__VIEWSTATE" value="x"/></form>');
    expect(result.legacy).toHaveProperty('aspnet-webforms');
    expect(isLegacy(result)).toBe(true);
  });

  it('flags old jQuery but not jQuery 3', () => {
    expect(fingerprint('<script src="/js/jquery-1.11.3.min.js">').legacy).toHaveProperty('jquery-old');
    expect(fingerprint('<script src="/js/jquery-2.2.4.js">').legacy).toHaveProperty('jquery-old');
    expect(fingerprint('<script src="/js/jquery-3.7.1.min.js">').legacy).not.toHaveProperty('jquery-old');
  });

  it('flags legacy server headers', () => {
    expect(fingerprint('', { Server: 'Apache/2.2.15 (CentOS)' }).legacy).toHaveProperty('old-apache');
    expect(fingerprint('', { 'X-Powered-By': 'PHP/5.6.40' }).legacy).toHaveProperty('php-legacy');
    expect(fingerprint('', { 'X-Powered-By': 'ASP.NET' }).legacy).toHaveProperty('aspnet');
    expect(fingerprint('', { Server: 'Microsoft-IIS/6.0' }).legacy).toHaveProperty('old-iis');
  });

  it('does not flag a current Apache or PHP 8', () => {
    expect(isLegacy(fingerprint('', { Server: 'Apache/2.4.58' }))).toBe(false);
    expect(isLegacy(fingerprint('', { 'X-Powered-By': 'PHP/8.3.2' }))).toBe(false);
  });

  it('flags AngularJS, Flash and table layouts', () => {
    expect(fingerprint('<html ng-app="myApp">').legacy).toHaveProperty('angularjs');
    expect(fingerprint('<embed src="intro.swf">').legacy).toHaveProperty('flash');
    expect(fingerprint('<table width="100%" cellpadding="0">').legacy).toHaveProperty('table-layout');
  });
});

describe('fingerprint — modern markers', () => {
  it('detects Next.js and React', () => {
    const result = fingerprint('<script id="__NEXT_DATA__">{}</script><div data-reactroot>');
    expect(result.modern).toHaveProperty('nextjs');
    expect(result.modern).toHaveProperty('react');
    expect(isLegacy(result)).toBe(false);
  });

  it('detects Vue and Nuxt', () => {
    expect(fingerprint('<div data-v-1a2b3c4d>').modern).toHaveProperty('vue');
    expect(fingerprint('<script>window.__NUXT__={}</script>').modern).toHaveProperty('nuxt');
  });

  it('detects a modern edge host from headers', () => {
    expect(fingerprint('', { Server: 'cloudflare' }).modern).toHaveProperty('cdn-modern');
  });
});

describe('fingerprint — mixed stacks', () => {
  /**
   * The case the whole engine is looking for: a modern front end bolted onto
   * a legacy back end. A modern marker must not cancel a legacy one.
   */
  it('still flags legacy when modern markers are also present', () => {
    const html = '<div data-reactroot></div><input name="__VIEWSTATE" value="x">';
    const result = fingerprint(html);
    expect(result.modern).toHaveProperty('react');
    expect(result.legacy).toHaveProperty('aspnet-webforms');
    expect(isLegacy(result)).toBe(true);
  });

  it('reports nothing for an empty page rather than guessing', () => {
    const result = fingerprint('<html><body></body></html>');
    expect(Object.keys(result.modern)).toHaveLength(0);
    expect(Object.keys(result.legacy)).toHaveLength(0);
    expect(isLegacy(result)).toBe(false);
  });
});

/**
 * A12: "No company on WordPress, WooCommerce, Shopify or Magento 2 produces
 * an F-LEG signal or a modernisation-pitch brief on that basis alone."
 *
 * These are published Rubico service lines. A company running one is a
 * company whose stack Rubico already staffs for — a capability match, not a
 * defect. The engine previously flagged wordpress.org itself as needing a
 * rebuild.
 */
describe('fingerprint — Rubico-serviced platforms are not defects (A12)', () => {
  const PLATFORMS: Array<[string, string]> = [
    ['wordpress', '<link href="/wp-content/themes/x.css">'],
    ['woocommerce', '<div class="woocommerce"><a class="wc-add-to-cart">'],
    ['shopify', '<script src="https://cdn.shopify.com/s/files/x.js">'],
    ['magento2', '<script src="/static/version1700000000/frontend/x.js" data-mage-init>'],
    ['drupal-current', '<script src="/core/misc/drupal.js">'],
  ];

  it.each(PLATFORMS)('puts %s in platform, never legacy', (key, html) => {
    const result = fingerprint(html);
    expect(result.platform).toHaveProperty(key);
    expect(result.legacy).not.toHaveProperty(key);
    expect(isLegacy(result)).toBe(false);
    expect(isServicedPlatform(result)).toBe(true);
  });

  it('detects Laravel from its session cookie', () => {
    const result = fingerprint('', { 'set-cookie': 'laravel_session=abc; path=/' });
    expect(result.platform).toHaveProperty('laravel');
    expect(isLegacy(result)).toBe(false);
  });

  // The case that proves these rules need version awareness, not presence
  // detection: same product, opposite meaning, decided by major version.
  describe('Magento by version', () => {
    it('treats Magento 1.x as legacy — end of life since June 2020', () => {
      const result = fingerprint('<link href="/skin/frontend/base/default/css/styles.css">');
      expect(result.legacy).toHaveProperty('magento1');
      expect(isLegacy(result)).toBe(true);
    });

    it('treats Magento 2 as a serviced platform', () => {
      const result = fingerprint('<script src="/pub/static/frontend/Magento/luma/x.js">');
      expect(result.platform).toHaveProperty('magento2');
      expect(isLegacy(result)).toBe(false);
    });

    it('lets Magento 2 win when both match, since M2 still ships /js/mage/ paths', () => {
      const result = fingerprint('<script src="/js/mage/cookies.js"></script><div data-mage-init>');
      expect(result.platform).toHaveProperty('magento2');
      expect(result.legacy).not.toHaveProperty('magento1');
      expect(isLegacy(result)).toBe(false);
    });
  });

  it('lets a platform and a genuine legacy marker coexist', () => {
    // A WooCommerce store on jQuery 1.x is both a capability match AND a
    // real modernisation lead. Neither cancels the other.
    const result = fingerprint(
      '<div class="woocommerce"></div><script src="/js/jquery-1.11.3.min.js">',
    );
    expect(result.platform).toHaveProperty('woocommerce');
    expect(result.legacy).toHaveProperty('jquery-old');
    expect(isLegacy(result)).toBe(true);
    expect(isServicedPlatform(result)).toBe(true);
  });

  // Caught live: stripe.com was flagged as WooCommerce because its homepage
  // advertises a WooCommerce integration.
  it('does not flag a page that merely mentions a platform by name', () => {
    const mentions = fingerprint(
      '<p>Works with WooCommerce, Shopify and Magento.</p><a href="/docs/woocommerce">Docs</a>',
    );
    expect(mentions.platform).not.toHaveProperty('woocommerce');
    expect(isServicedPlatform(mentions)).toBe(false);
  });

  it('still detects a real WooCommerce storefront', () => {
    for (const html of [
      '<link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">',
      '<body class="woocommerce-page woocommerce">',
      '<a class="wc-add-to-cart" href="#">Add</a>',
    ]) {
      expect(fingerprint(html).platform).toHaveProperty('woocommerce');
    }
  });

  it('does not treat a plain modern site as a serviced platform', () => {
    const result = fingerprint('<script id="__NEXT_DATA__">{}</script>');
    expect(isServicedPlatform(result)).toBe(false);
    expect(isLegacy(result)).toBe(false);
  });
});

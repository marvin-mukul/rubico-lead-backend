import { fingerprint, isLegacy } from './fingerprint.js';

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

  it('flags WordPress, AngularJS, Flash and table layouts', () => {
    expect(fingerprint('<link href="/wp-content/themes/x.css">').legacy).toHaveProperty('wordpress');
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

import { AppConfigService } from '../../common/config/app-config.service.js';
import { SourceHttpClient } from '../http/source-http.client.js';
import { extractCompanyDomain } from './press-release-domain.js';
import { PressReleaseSource } from './press-release.source.js';
import { parseRssItems, stripHtml } from './rss-parser.js';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<item>
  <title>Acme Corp Launches New Ecommerce Platform</title>
  <link>https://www.prnewswire.com/news-releases/acme-launches-302000001.html</link>
  <guid>https://www.prnewswire.com/news-releases/acme-launches-302000001.html</guid>
  <pubDate>Fri, 11 Sep 2026 07:00:00 +0000</pubDate>
  <description><![CDATA[<p>NEW YORK, Sept. 11, 2026 /PRNewswire/ -- Acme Corp today announced a new digital commerce platform. For more information, visit www.acme-corp.com.</p>]]></description>
</item>
<item>
  <title>Mayer Brown Adds Ashton and Bates to Leading Capital Markets Practice</title>
  <link>https://www.prnewswire.com/news-releases/mayer-brown-302000002.html</link>
  <guid>https://www.prnewswire.com/news-releases/mayer-brown-302000002.html</guid>
  <pubDate>Fri, 11 Sep 2026 07:00:00 +0000</pubDate>
  <description><![CDATA[<p>LONDON, Sept. 11, 2026 /PRNewswire/ -- Mayer Brown today announced that Scott Ashton has joined the firm.</p>]]></description>
</item>
<item>
  <title>Stale Item With No Recent Date</title>
  <link>https://www.prnewswire.com/news-releases/stale-302000003.html</link>
  <pubDate>Mon, 01 Jan 2024 07:00:00 +0000</pubDate>
  <description><![CDATA[<p>Visit https://stale-example.com for details.</p>]]></description>
</item>
</channel></rss>`;

describe('parseRssItems', () => {
  it('extracts title, link, pubDate and CDATA-stripped description', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe('Acme Corp Launches New Ecommerce Platform');
    expect(items[0].link).toBe('https://www.prnewswire.com/news-releases/acme-launches-302000001.html');
    expect(items[0].description).toContain('www.acme-corp.com');
    expect(items[0].description).not.toContain('CDATA');
  });

  it('drops an item with no title or no link', () => {
    const items = parseRssItems('<item><title>Only a title</title></item>');
    expect(items).toHaveLength(0);
  });

  it('decodes XML entities outside CDATA', () => {
    const items = parseRssItems(
      '<item><title>AT&amp;T &amp; Partners</title><link>https://example.test/x</link></item>',
    );
    expect(items[0].title).toBe('AT&T & Partners');
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>world</b></p>\n\n')).toBe('Hello world');
  });
});

describe('extractCompanyDomain', () => {
  it('finds a scheme-prefixed company URL', () => {
    expect(extractCompanyDomain('Visit https://www.acme-corp.com for more.')).toBe('acme-corp.com');
  });

  it('finds a bare www.-prefixed mention', () => {
    expect(extractCompanyDomain('For more information, visit www.acme-corp.com.')).toBe(
      'acme-corp.com',
    );
  });

  it('ignores the wire service and social hosts, preferring the real company domain', () => {
    expect(
      extractCompanyDomain(
        'Follow us on https://twitter.com/acme and visit https://www.acme-corp.com today. See www.prnewswire.com for more releases.',
      ),
    ).toBe('acme-corp.com');
  });

  it('returns null when no URL is present — no name-based guessing (A14)', () => {
    expect(extractCompanyDomain('Mayer Brown today announced a new partner.')).toBeNull();
  });

  it('does not mistake ordinary abbreviations for a domain', () => {
    expect(extractCompanyDomain('The U.S. firm reported results for Q3.')).toBeNull();
  });
});

describe('PressReleaseSource.fetch', () => {
  const config = {
    pressReleaseFeeds: ['https://feed.test/tech.rss'],
  } as unknown as AppConfigService;

  it('emits S7 signals only for releases that name their own domain, and skips stale ones', async () => {
    const http = {
      getText: async () => SAMPLE_RSS,
    } as unknown as SourceHttpClient;

    const source = new PressReleaseSource(http, config);
    const signals = await source.fetch(new Date('2026-01-01T00:00:00Z'));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      domain: 'acme-corp.com',
      type: 'S7',
      sourceName: 'press-release',
      subject: 'press-release Acme Corp Launches New Ecommerce Platform',
    });
  });

  it('one dead feed does not stop the others', async () => {
    const twoFeedConfig = {
      pressReleaseFeeds: ['https://dead.test/rss', 'https://feed.test/tech.rss'],
    } as unknown as AppConfigService;

    const http = {
      getText: async (req: { url: string }) => {
        if (req.url.includes('dead.test')) throw new Error('network error');
        return SAMPLE_RSS;
      },
    } as unknown as SourceHttpClient;

    const source = new PressReleaseSource(http, twoFeedConfig);
    const signals = await source.fetch(new Date('2026-01-01T00:00:00Z'));

    expect(signals).toHaveLength(1);
  });
});

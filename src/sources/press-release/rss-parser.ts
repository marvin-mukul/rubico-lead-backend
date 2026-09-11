/**
 * A minimal RSS 2.0 `<item>` parser — regex-based, like the SEC fixed-width
 * parser, rather than a new dependency for one feed shape. Verified live
 * 2026-09-11 against the PRNewswire technology feed (real RSS 2.0, `title`/
 * `link`/`guid`/`pubDate`/CDATA-wrapped HTML `description`).
 */

export interface RssItem {
  title: string;
  link: string;
  guid?: string;
  pubDate?: string;
  /** Raw, already CDATA-stripped — may still contain HTML tags. */
  description?: string;
}

export function parseRssItems(xml: string): RssItem[] {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
  const items: RssItem[] = [];

  for (const block of blocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    if (!title || !link) continue;

    const guid = extractTag(block, 'guid');
    const pubDate = extractTag(block, 'pubDate');
    const description = extractTag(block, 'description');

    items.push({
      title,
      link,
      ...(guid ? { guid } : {}),
      ...(pubDate ? { pubDate } : {}),
      ...(description ? { description } : {}),
    });
  }

  return items;
}

/** Strips every HTML tag and collapses whitespace, for a plain-text excerpt. */
export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  if (!match) return undefined;
  return decodeXmlEntities(stripCdata(match[1])).trim();
}

function stripCdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(value);
  return match ? match[1] : value;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

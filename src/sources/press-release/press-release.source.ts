import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { SignalType } from '../../common/domain/index.js';
import type { RawSignal } from '../../signals/index.js';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { SignalSource } from '../signal-source.interface.js';
import { extractCompanyDomain } from './press-release-domain.js';
import { parseRssItems, stripHtml } from './rss-parser.js';

/**
 * Press-release RSS (§7.2, P25, signal type S7 — a STATED initiative, E2).
 *
 * Free, unauthenticated, config-driven feed list (`PRESS_RELEASE_FEEDS`),
 * same "config, not code" shape as `HACKERNEWS_QUERIES`. One feed — the
 * PRNewswire technology/software category — is verified live; more can be
 * added without a deploy once their real feed URLs are known (BusinessWire's
 * RSS is per-channel-id, not a bare public endpoint — see the env schema).
 *
 * A release only becomes a signal if its OWN text names a domain (the
 * boilerplate "visit www.company.com" pattern) — see press-release-domain.ts
 * for why this does not attempt name->domain resolution. One dead or
 * malformed feed is logged and skipped, so it cannot end the run for the
 * others.
 */
@Injectable()
export class PressReleaseSource implements SignalSource {
  readonly name = 'press-release';
  readonly signalTypes: SignalType[] = ['S7'];

  private readonly logger = new Logger(PressReleaseSource.name);

  constructor(
    private readonly http: SourceHttpClient,
    private readonly config: AppConfigService,
  ) {}

  async fetch(since: Date): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];

    for (const feedUrl of this.config.pressReleaseFeeds) {
      let withoutDomain = 0;
      let stale = 0;

      try {
        const xml = await this.http.getText({ url: feedUrl, minIntervalMs: 300 });
        const items = parseRssItems(xml ?? '');

        for (const item of items) {
          const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date();
          if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) {
            stale++;
            continue;
          }

          const description = item.description ? stripHtml(item.description) : '';
          const domain = extractCompanyDomain(`${item.title} ${description}`);
          if (!domain) {
            withoutDomain++;
            continue;
          }

          signals.push({
            domain,
            companyName: domain,
            type: 'S7',
            eventDate: publishedAt,
            sourceUrl: item.link,
            sourceName: 'press-release',
            excerpt: description ? description.slice(0, 500) : item.title,
            // Per title, per day: a wire that syndicates one release under
            // two guids (measured live — PRNewswire does this) collapses to
            // one signal, which is correct; a genuinely new release does not.
            subject: `press-release ${item.title}`,
            raw: { ...item, feedUrl },
          });
        }

        this.logger.log(
          `${feedUrl}: ${items.length} item(s), ${withoutDomain} without an extractable domain, ${stale} stale`,
        );
      } catch (error) {
        this.logger.warn(
          `${feedUrl} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return signals;
  }
}

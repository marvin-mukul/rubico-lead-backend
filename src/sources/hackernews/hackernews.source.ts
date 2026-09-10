import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { SignalType } from '../../common/domain/index.js';
import type { RawSignal } from '../../signals/index.js';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { SignalSource } from '../signal-source.interface.js';

interface AlgoliaHit {
  objectID: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at: string;
  created_at_i: number;
}

/**
 * Hacker News via the Algolia API (§7.2, signal type S3: pain signals).
 * Free and unauthenticated.
 *
 * A story only becomes a signal if it links somewhere with a resolvable
 * company domain — a discussion with no target company is noise, and
 * IngestionService will drop it as `filteredOut` anyway.
 */
@Injectable()
export class HackerNewsSource implements SignalSource {
  readonly name = 'hackernews';
  readonly signalTypes: SignalType[] = ['S3'];

  private readonly logger = new Logger(HackerNewsSource.name);

  constructor(
    private readonly http: SourceHttpClient,
    private readonly config: AppConfigService,
  ) {}

  async fetch(since: Date): Promise<RawSignal[]> {
    const after = Math.floor(since.getTime() / 1000);
    const signals: RawSignal[] = [];
    const seen = new Set<string>();

    for (const query of this.config.hackerNewsQueries) {
      const url =
        'https://hn.algolia.com/api/v1/search_by_date' +
        `?query=${encodeURIComponent(query)}` +
        '&tags=story' +
        `&numericFilters=created_at_i>${after}` +
        '&hitsPerPage=50';

      const body = await this.http.getJson<{ hits?: AlgoliaHit[] }>({
        url,
        minIntervalMs: 250,
      });

      for (const hit of body?.hits ?? []) {
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);

        const target = hit.url ?? hit.story_url;
        const title = hit.title ?? hit.story_title;
        if (!target || !title) continue;

        signals.push({
          domain: target,
          companyName: hostOf(target) ?? title,
          type: 'S3',
          eventDate: new Date(hit.created_at),
          sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          sourceName: this.name,
          excerpt: title,
          subject: `hn ${title}`,
          raw: { ...hit, matchedQuery: query },
        });
      }
    }

    this.logger.log(
      `${signals.length} story signal(s) from ${this.config.hackerNewsQueries.length} queries`,
    );
    return signals;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { SignalType } from '../../common/domain/index.js';
import type { RawSignal } from '../../signals/index.js';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { SignalSource } from '../signal-source.interface.js';
import { parseHiringPost } from './hiring-post.parser.js';

interface AlgoliaStory {
  objectID: string;
  title?: string;
  created_at: string;
}

interface AlgoliaComment {
  objectID: string;
  comment_text?: string;
  parent_id?: number;
  story_id?: number;
  created_at: string;
}

/**
 * "Ask HN: Who is hiring?" — the monthly thread, as a company DISCOVERY
 * source (signal type S2).
 *
 * This exists because the engine had one high-volume discovery source, EU
 * procurement, which finds European public bodies that buy through tender.
 * Measured on the live database before this was added: 612 of 644 companies
 * came from TED-EU, 11 from US procurement, and **four** from job boards —
 * stripe, figma, ramp and duolingo, because `AtsSource` only re-checks boards
 * for companies already known. The engine had no way at all to find a US
 * software company.
 *
 * This thread is several hundred of them a month, in English, each one
 * stating its stack and what it cannot build fast enough. Free, no key, no
 * rate limit worth the name.
 *
 * Measured yield, September 2026 thread: 256 top-level posts, 190 parsed to a
 * company domain (74%), 183 unique companies, 23 linking straight to an ATS
 * board — which `AtsSlugDiscoveryEnricher` then turns into a continuous job
 * feed rather than a one-off post.
 *
 * Only "Who is hiring?" is read, never "Who wants to be hired?" — that thread
 * is individuals looking for work, and every row it produced would be a
 * person misfiled as a company.
 */
@Injectable()
export class HackerNewsHiringSource implements SignalSource {
  readonly name = 'hackernews-hiring';
  readonly signalTypes: SignalType[] = ['S2'];

  private readonly logger = new Logger(HackerNewsHiringSource.name);

  constructor(
    private readonly http: SourceHttpClient,
    private readonly config: AppConfigService,
  ) {}

  async fetch(since: Date): Promise<RawSignal[]> {
    const threads = await this.recentThreads();
    if (threads.length === 0) {
      this.logger.warn('No "Who is hiring?" threads found — has the HN Algolia API changed?');
      return [];
    }

    const signals: RawSignal[] = [];
    const seenPerThread = new Set<string>();

    for (const thread of threads) {
      const comments = await this.topLevelComments(thread.objectID);
      let parsed = 0;

      for (const comment of comments) {
        const post = parseHiringPost(comment.comment_text ?? '');
        // No resolvable company domain — see the parser's file comment.
        if (!post) continue;

        // One company can post twice in the same thread (a second role). That
        // is one hiring event, not two, so it is deduped here rather than
        // left for the signal-level dedupe, which buckets on subject+date and
        // would see two different comment dates.
        const key = `${thread.objectID}:${post.domain}`;
        if (seenPerThread.has(key)) continue;
        seenPerThread.add(key);
        parsed++;

        signals.push({
          domain: post.domain,
          companyName: post.companyName,
          type: 'S2',
          eventDate: new Date(comment.created_at),
          sourceUrl: `https://news.ycombinator.com/item?id=${comment.objectID}`,
          sourceName: this.name,
          excerpt: post.excerpt,
          // The thread is the event: "this company was hiring in September".
          // Keyed on the thread rather than the month string so a re-run
          // against the same thread cannot produce a second signal.
          subject: `hn-hiring-${thread.objectID}`,
          raw: {
            threadId: thread.objectID,
            threadTitle: thread.title,
            commentId: comment.objectID,
            location: post.location,
            // Read by AtsSlugDiscoveryEnricher: an OBSERVED board beats a
            // guessed one, and this is the only place the engine ever sees a
            // slug stated rather than probed for.
            ats: post.ats,
          },
        });
      }

      this.logger.log(
        `${thread.title ?? thread.objectID}: ${parsed} company(ies) from ${comments.length} top-level post(s)`,
      );
    }

    // `since` is deliberately unused for filtering. The threads are monthly,
    // so a watermark-driven window would skip the current month for 30 days
    // at a time; the signal-level dedupe on (subject, eventDate) is what
    // makes re-reading a thread free.
    void since;

    this.logger.log(`${signals.length} hiring signal(s) from ${threads.length} thread(s)`);
    return signals;
  }

  /** The N most recent "Who is hiring?" threads, newest first. */
  private async recentThreads(): Promise<AlgoliaStory[]> {
    const body = await this.http.getJson<{ hits?: AlgoliaStory[] }>({
      url:
        'https://hn.algolia.com/api/v1/search_by_date' +
        '?tags=story,author_whoishiring' +
        '&hitsPerPage=40',
      minIntervalMs: 250,
    });

    return (body?.hits ?? [])
      .filter((hit) => /who is hiring/i.test(hit.title ?? ''))
      .slice(0, this.config.hackerNewsHiringThreads);
  }

  /**
   * Top-level comments only.
   *
   * A reply is a candidate answering a post, not a company hiring. Algolia
   * returns the whole subtree, and `parent_id === story_id` is what separates
   * the two — measured on the September thread, 387 comments contained 256
   * actual job posts.
   */
  private async topLevelComments(storyId: string): Promise<AlgoliaComment[]> {
    const body = await this.http.getJson<{ hits?: AlgoliaComment[] }>({
      url:
        'https://hn.algolia.com/api/v1/search' +
        `?tags=comment,story_${storyId}` +
        '&hitsPerPage=1000',
      minIntervalMs: 250,
    });

    return (body?.hits ?? []).filter(
      (hit) => hit.parent_id !== undefined && hit.parent_id === hit.story_id,
    );
  }
}

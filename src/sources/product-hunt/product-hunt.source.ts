import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { SignalType } from '../../common/domain/index.js';
import type { RawSignal } from '../../signals/index.js';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { SignalSource } from '../signal-source.interface.js';

interface PostNode {
  id: string;
  name: string;
  tagline?: string;
  website?: string;
  url?: string;
  createdAt: string;
  votesCount?: number;
}

interface GraphQlResponse {
  data?: { posts?: { edges?: Array<{ node: PostNode }> } };
  errors?: Array<{ message: string }>;
}

const ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';

/**
 * Product Hunt launches (§7.2, signal type S4).
 *
 * Uses the v2 GraphQL API with `PRODUCT_HUNT_TOKEN`. The token is a
 * developer token, not a billed credential, so this stays outside
 * MeteredClient.
 *
 * `website` is what makes a launch usable: it is the company's own domain,
 * unlike the producthunt.com post URL, which the canonical-domain resolver
 * rejects as an aggregator.
 */
@Injectable()
export class ProductHuntSource implements SignalSource {
  readonly name = 'product-hunt';
  readonly signalTypes: SignalType[] = ['S4'];

  private readonly logger = new Logger(ProductHuntSource.name);

  constructor(
    private readonly http: SourceHttpClient,
    private readonly config: AppConfigService,
  ) {}

  async fetch(since: Date): Promise<RawSignal[]> {
    const query = `
      query RecentLaunches($after: DateTime!) {
        posts(order: NEWEST, postedAfter: $after, first: 50) {
          edges {
            node { id name tagline website url createdAt votesCount }
          }
        }
      }`;

    const body = await this.http.postJson<GraphQlResponse>({
      url: ENDPOINT,
      body: { query, variables: { after: since.toISOString() } },
      headers: { authorization: `Bearer ${this.config.productHuntToken}` },
      minIntervalMs: 300,
    });

    if (body?.errors?.length) {
      // Surfaced as a run failure so a bad or expired token is visible
      // rather than quietly producing zero launches every day.
      throw new Error(`Product Hunt API error: ${body.errors.map((e) => e.message).join('; ')}`);
    }

    const edges = body?.data?.posts?.edges ?? [];
    const signals: RawSignal[] = [];

    for (const { node } of edges) {
      if (!node.website) continue;
      signals.push({
        domain: node.website,
        companyName: node.name,
        type: 'S4',
        eventDate: new Date(node.createdAt),
        sourceUrl: node.url ?? `https://www.producthunt.com/posts/${node.id}`,
        sourceName: this.name,
        ...(node.tagline ? { excerpt: node.tagline } : {}),
        subject: `launch ${node.name}`,
        raw: node,
      });
    }

    this.logger.log(`${signals.length} launch signal(s) of ${edges.length} posts`);
    return signals;
  }
}

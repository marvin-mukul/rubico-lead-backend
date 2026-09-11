import type { AppConfigService } from '../../common/config/app-config.service.js';
import type { SourceHttpClient } from '../http/source-http.client.js';
import { ProductHuntSource } from './product-hunt.source.js';

/**
 * P27: the code has been complete since P8c — `PRODUCT_HUNT_TOKEN` is still
 * a placeholder, so the live GraphQL round-trip is unverified (needs a real
 * token, out of this session's control). What IS verifiable now is the
 * deterministic logic around that call: the config it needs, error
 * surfacing, and the RawSignal shape it builds.
 */
const config = { productHuntToken: 'test-token' } as unknown as AppConfigService;

describe('ProductHuntSource', () => {
  it('skips a post with no website — the producthunt.com URL is rejected as an aggregator', async () => {
    const http = {
      postJson: async () => ({
        data: {
          posts: {
            edges: [
              { node: { id: '1', name: 'No Website Co', createdAt: '2026-09-01T00:00:00Z' } },
              {
                node: {
                  id: '2',
                  name: 'Acme',
                  website: 'https://acme.test',
                  url: 'https://www.producthunt.com/posts/acme',
                  tagline: 'Acme does things',
                  createdAt: '2026-09-01T00:00:00Z',
                },
              },
            ],
          },
        },
      }),
    } as unknown as SourceHttpClient;

    const source = new ProductHuntSource(http, config);
    const signals = await source.fetch(new Date('2026-08-01T00:00:00Z'));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      domain: 'https://acme.test',
      companyName: 'Acme',
      type: 'S4',
      sourceUrl: 'https://www.producthunt.com/posts/acme',
      excerpt: 'Acme does things',
      subject: 'launch Acme',
    });
  });

  it('surfaces a GraphQL error rather than silently returning zero launches', async () => {
    const http = {
      postJson: async () => ({ errors: [{ message: 'Invalid token' }] }),
    } as unknown as SourceHttpClient;

    const source = new ProductHuntSource(http, config);
    await expect(source.fetch(new Date())).rejects.toThrow(/Invalid token/);
  });

  it('sends the configured token as a bearer header', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const http = {
      postJson: async (req: { headers?: Record<string, string> }) => {
        capturedHeaders = req.headers;
        return { data: { posts: { edges: [] } } };
      },
    } as unknown as SourceHttpClient;

    const source = new ProductHuntSource(http, config);
    await source.fetch(new Date());

    expect(capturedHeaders?.authorization).toBe('Bearer test-token');
  });
});

import { z } from 'zod';
import { testConfig } from '../../../test/support/config.factory.js';
import { GeminiProvider } from './gemini.provider.js';

/**
 * Unlike the Anthropic provider (the official SDK retries 429/5xx on its
 * own), this is a hand-rolled `fetch()` — so nothing retries a rate limit
 * unless GeminiProvider does it itself. That matters concretely on a
 * free-tier key's low RPM ceiling: `completeMany` runs classify calls
 * sequentially with no pacing, so without a retry, the first throttled
 * company would fail every remaining one in that batch too.
 */
describe('GeminiProvider retry behaviour', () => {
  const schema = z.object({ ok: z.boolean() });
  const args = { model: 'gemini-3.5-flash-lite', system: 'sys', user: 'usr', schema };

  const geminiBody = (ok = true) =>
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ ok }) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });

  const mockFetch = (statuses: number[]) => {
    let call = 0;
    const fn = vi.fn(async () => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call++;
      return new Response(status === 200 ? geminiBody() : '{}', {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fn);
    return { fn, calls: () => call };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries once on 429 and succeeds', async () => {
    const { calls } = mockFetch([429, 200]);
    const provider = new GeminiProvider(testConfig());

    const result = await provider.complete(args);

    expect(result.result).toEqual({ ok: true });
    expect(calls()).toBe(2);
  });

  it('retries a 5xx the same as a 429', async () => {
    const { calls } = mockFetch([503, 503, 200]);
    const provider = new GeminiProvider(testConfig());

    await provider.complete(args);

    expect(calls()).toBe(3);
  });

  it('gives up after the retry budget and reports the real status', async () => {
    const { calls } = mockFetch([429, 429, 429, 429]);
    const provider = new GeminiProvider(testConfig());

    await expect(provider.complete(args)).rejects.toThrow(/429/);
    // Capped at MAX_ATTEMPTS — a persistent throttle must not spin forever.
    expect(calls()).toBe(3);
  });

  it('does not retry a non-retryable status, e.g. 400', async () => {
    const { calls } = mockFetch([400, 200]);
    const provider = new GeminiProvider(testConfig());

    await expect(provider.complete(args)).rejects.toThrow(/400/);
    // One attempt only — retrying a bad request would just repeat the same error.
    expect(calls()).toBe(1);
  });

  it('does not retry once Gemini has already returned a usable response', async () => {
    const { calls } = mockFetch([200]);
    const provider = new GeminiProvider(testConfig());

    await provider.complete(args);

    expect(calls()).toBe(1);
  });
});

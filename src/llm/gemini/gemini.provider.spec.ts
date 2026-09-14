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

/**
 * Measured live against a free-tier key on 2026-09-14: 16 sequential
 * requests succeeded, the 17th and every one after it got a 429 with no
 * `Retry-After` header, and it did not recover within several more seconds —
 * a hard per-minute wall. Retrying cannot fix that; only spacing calls out
 * so the wall is never approached can. These tests pin that spacing exists
 * and is enforced across consecutive calls, not just within one.
 */
describe('GeminiProvider call pacing', () => {
  const schema = z.object({ ok: z.boolean() });
  const args = { model: 'gemini-3.5-flash-lite', system: 'sys', user: 'usr', schema };
  const geminiBody = JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });

  const mockFetch = () => {
    const dispatchedAt: number[] = [];
    const fn = vi.fn(async () => {
      dispatchedAt.push(Date.now());
      return new Response(geminiBody, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fn);
    return dispatchedAt;
  };

  // Real timers, deliberately — not fake ones. `fetchWithRetry` constructs a
  // real `AbortSignal.timeout()`, which is not one of the primitives vitest's
  // fake timers intercept; mixing the two here left `advanceTimersByTimeAsync`
  // hanging, waiting on a real timer that fake-advancing can never resolve.
  // A few real seconds of test time is a fair trade for a test that doesn't
  // depend on fake-timer/AbortSignal interaction working out.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches the first call immediately, with no wait', async () => {
    const dispatchedAt = mockFetch();
    const provider = new GeminiProvider(testConfig());
    const start = Date.now();

    await provider.complete(args);

    expect(dispatchedAt[0]! - start).toBeLessThan(200);
  });

  it('spaces two back-to-back calls at least MIN_CALL_INTERVAL_MS apart', async () => {
    const dispatchedAt = mockFetch();
    const provider = new GeminiProvider(testConfig());

    await provider.complete(args);
    await provider.complete(args);

    expect(dispatchedAt).toHaveLength(2);
    // The actual safety property is a MINIMUM gap — a shorter one is what
    // would risk the free-tier wall again. No meaningful upper bound: real
    // scheduling jitter (event loop load, CI variance) is not a correctness
    // bug, so asserting one would only make this test flaky for no reason.
    // A small tolerance below the nominal floor absorbs `setTimeout`'s own
    // sub-millisecond scheduling slack — a real pacing bug shows up as a gap
    // near 0ms or double the interval, not 1-2ms short.
    expect(dispatchedAt[1]! - dispatchedAt[0]!).toBeGreaterThanOrEqual(4_490);
  }, 10_000);

  it('does not compound extra delay onto a call that arrives after its slot has already passed', async () => {
    const dispatchedAt = mockFetch();
    const provider = new GeminiProvider(testConfig());

    await provider.complete(args);
    // Longer than MIN_CALL_INTERVAL_MS, so the reserved slot from the first
    // call is already in the past by the time the second one arrives.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const before = Date.now();
    await provider.complete(args);

    // Should dispatch almost immediately — not wait out a fresh 4500ms on
    // top of the 5000ms that already elapsed on its own.
    expect(dispatchedAt[1]! - before).toBeLessThan(200);
  }, 10_000);
});

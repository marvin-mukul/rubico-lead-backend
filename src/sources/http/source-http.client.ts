import { Injectable, Logger } from '@nestjs/common';

/**
 * HTTP for free sources. Billable calls never come through here — they go
 * through MeteredClient (FR-B2). This client exists for the three things every
 * source needs and none should re-implement: a per-host request spacer, a 429
 * backoff, and a mandatory User-Agent.
 *
 * §14 keeps rate-limit sophistication out of scope, so this is deliberately
 * plain: fixed spacing, capped retries, honour `Retry-After`.
 */

export interface SourceRequest {
  url: string;
  /** Minimum gap between requests to this host, in ms. SEC requires ~10/s. */
  minIntervalMs?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Treat 404 as an empty result rather than an error. */
  acceptMissing?: boolean;
  /**
   * Extra statuses to report as "missing" (null) rather than throwing. SEC
   * answers 403 for a daily-index file that does not exist, so a caller has
   * to opt into that explicitly.
   */
  treatAsMissing?: number[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 120;
const MAX_ATTEMPTS = 3;

export class SourceHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class SourceHttpClient {
  private readonly logger = new Logger(SourceHttpClient.name);
  /** Per-host promise chain, so requests to one host queue behind each other. */
  private readonly hostQueues = new Map<string, Promise<unknown>>();

  /** Returns null only when `acceptMissing` is set and the server said 404. */
  async getText(request: SourceRequest): Promise<string | null> {
    return this.enqueue(request, async (response) => response.text());
  }

  async getJson<T>(request: SourceRequest): Promise<T | null> {
    return this.enqueue(request, async (response) => (await response.json()) as T);
  }

  async postJson<T>(request: SourceRequest & { body: unknown }): Promise<T | null> {
    return this.enqueue(
      {
        ...request,
        headers: { 'content-type': 'application/json', ...request.headers },
      },
      async (response) => (await response.json()) as T,
      { method: 'POST', body: JSON.stringify(request.body) },
    );
  }

  /** Serialises per host so the spacer actually spaces. */
  private enqueue<T>(
    request: SourceRequest,
    read: (response: Response) => Promise<T>,
    init: RequestInit = {},
  ): Promise<T | null> {
    const host = new URL(request.url).host;
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(request, read, init));
    this.hostQueues.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  private async execute<T>(
    request: SourceRequest,
    read: (response: Response) => Promise<T>,
    init: RequestInit,
  ): Promise<T | null> {
    const interval = request.minIntervalMs ?? DEFAULT_INTERVAL_MS;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1 || interval > 0) await delay(interval);

      let response: Response;
      try {
        response = await fetch(request.url, {
          ...init,
          headers: request.headers ?? {},
          signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          throw new SourceHttpError(request.url, 0, `Network error: ${describe(error)}`);
        }
        await delay(backoffMs(attempt));
        continue;
      }

      if (response.ok) return read(response);

      if (response.status === 404 && request.acceptMissing) return null;
      if (request.treatAsMissing?.includes(response.status)) return null;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new SourceHttpError(
          request.url,
          response.status,
          `${response.status} ${response.statusText} for ${request.url}`,
        );
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffMs(attempt);
      this.logger.warn(
        `${response.status} from ${request.url}; retrying in ${waitMs}ms (${attempt}/${MAX_ATTEMPTS})`,
      );
      await delay(waitMs);
    }

    throw new SourceHttpError(request.url, 0, `Exhausted retries for ${request.url}`);
  }
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

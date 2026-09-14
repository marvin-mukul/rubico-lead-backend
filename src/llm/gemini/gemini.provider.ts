import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { TokenUsage } from '../../common/config/price-table.js';
import type {
  LlmCompleteArgs,
  LlmCompletion,
  LlmProvider,
} from '../llm-provider.interface.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 60_000;
/** Retryable attempts for a 429/5xx. Mirrors sources/http/source-http.client.ts. */
const MAX_ATTEMPTS = 3;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

/**
 * Gemini provider — used for classification (§10, LLM_CLASSIFY_MODEL).
 *
 * Uses the REST API directly rather than pulling in another SDK for one
 * endpoint. As with the Anthropic provider, this class knows nothing about
 * budgets or `api_usage`; MeteredClient owns both (FR-B2).
 *
 * Caching note: Gemini 2.5 applies implicit caching to a repeated prefix
 * automatically, so FR-AI4 is satisfied by putting the stable system prompt
 * first rather than by an explicit cachedContents call. `cachedContentTokenCount`
 * is reported back so the saving is visible in `api_usage`.
 *
 * Retry note: unlike the Anthropic provider — whose official SDK retries
 * 429/5xx on its own — this is a hand-rolled `fetch()`, so nothing retries a
 * rate limit unless this class does it. That matters concretely because
 * `completeMany` below runs classify calls sequentially with no pacing: on a
 * free-tier key's low RPM ceiling, a 200-company batch would otherwise fail
 * every remaining company for the rest of that run the moment the first one
 * gets throttled, rather than backing off and continuing. Mirrors the same
 * retry shape `sources/http/source-http.client.ts` already uses for the free
 * ingest sources — capped attempts, honour `Retry-After`, exponential backoff
 * otherwise.
 */
@Injectable()
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  private readonly logger = new Logger(GeminiProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async complete<T>(args: LlmCompleteArgs<T>): Promise<LlmCompletion<T>> {
    const url = `${ENDPOINT}/${args.model}:generateContent`;
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: 'user', parts: [{ text: args.user }] }],
      generationConfig: {
        // FR-AI2: the schema constrains generation; no free-text parsing.
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(z.toJSONSchema(args.schema, { target: 'draft-2020-12' })),
        maxOutputTokens: args.maxTokens ?? 4_000,
        temperature: 0,
      },
    });

    const response = await this.fetchWithRetry(url, requestBody);
    const body = (await response.json()) as GeminiResponse;
    if (!response.ok || body.error) {
      throw new Error(`Gemini ${response.status}: ${body.error?.message ?? response.statusText}`);
    }

    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    if (!text.trim()) {
      throw new Error(
        `Gemini returned no content (finishReason: ${body.candidates?.[0]?.finishReason ?? 'unknown'})`,
      );
    }

    const usage: TokenUsage = {
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      cachedInputTokens: body.usageMetadata?.cachedContentTokenCount ?? 0,
    };

    return { result: args.schema.parse(JSON.parse(text)), usage };
  }

  /**
   * A 429 or 5xx retries up to `MAX_ATTEMPTS`; anything else — including a
   * 200 carrying a Gemini-level `error` field — is returned as-is for
   * `complete` to interpret, since that shape isn't a transport failure.
   */
  private async fetchWithRetry(url: string, body: string): Promise<Response> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.config.apiKeyFor('gemini'),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) return response;

      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : 500 * 2 ** (attempt - 1);
      this.logger.warn(
        `Gemini ${response.status}; retrying in ${waitMs}ms (${attempt}/${MAX_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    // Unreachable — the loop always returns by the final attempt — but
    // satisfies the compiler's control-flow analysis.
    throw new Error('Gemini: exhausted retries');
  }

  /**
   * Gemini's batch API is a separate long-running job service. At Phase 0
   * volume the classify step is already the cheap half of the bill, so this
   * runs sequentially rather than adding that machinery. FR-AI3 asks for
   * batching on *briefs*, which is the Anthropic path.
   */
  async completeMany<T>(
    args: Array<LlmCompleteArgs<T> & { key: string }>,
  ): Promise<Array<{ key: string; completion?: LlmCompletion<T>; error?: string }>> {
    const out: Array<{ key: string; completion?: LlmCompletion<T>; error?: string }> = [];
    for (const arg of args) {
      try {
        out.push({ key: arg.key, completion: await this.complete(arg) });
      } catch (error) {
        out.push({ key: arg.key, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }
}

/**
 * Gemini accepts an OpenAPI 3 subset, not full JSON Schema: it rejects
 * `$schema`, `additionalProperties` and `const`, among others. Strip what it
 * cannot take rather than hand-maintaining a second schema per prompt.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const unsupported = new Set(['$schema', 'additionalProperties', 'const', '$id', 'default']);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (unsupported.has(key)) continue;
    out[key] = toGeminiSchema(value);
  }
  return out;
}

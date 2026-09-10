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
 */
@Injectable()
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  private readonly logger = new Logger(GeminiProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async complete<T>(args: LlmCompleteArgs<T>): Promise<LlmCompletion<T>> {
    const url = `${ENDPOINT}/${args.model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.config.apiKeyFor('gemini'),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.system }] },
        contents: [{ role: 'user', parts: [{ text: args.user }] }],
        generationConfig: {
          // FR-AI2: the schema constrains generation; no free-text parsing.
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(z.toJSONSchema(args.schema, { target: 'draft-2020-12' })),
          maxOutputTokens: args.maxTokens ?? 4_000,
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.json()) as GeminiResponse;
    if (!response.ok || body.error) {
      throw new Error(
        `Gemini ${response.status}: ${body.error?.message ?? response.statusText}`,
      );
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

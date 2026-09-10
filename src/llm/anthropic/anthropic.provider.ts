import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { TokenUsage } from '../../common/config/price-table.js';
import type {
  LlmCompleteArgs,
  LlmCompletion,
  LlmProvider,
} from '../llm-provider.interface.js';

/** How long to wait for a batch before giving up and retrying next run. */
const BATCH_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const BATCH_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_TOKENS = 8_000;

/** The SDK reports cache fields as `number | null`, not optional. */
interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Anthropic provider — used for brief generation (§10, LLM_BRIEF_MODEL).
 *
 * Note what this class does NOT do: it never checks a budget and never writes
 * `api_usage`. Both belong to MeteredClient (FR-B2), which wraps every call
 * to this provider. Keeping the two apart is what makes the cap impossible to
 * bypass by adding a provider.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic;

  constructor(private readonly config: AppConfigService) {
    this.client = new Anthropic({ apiKey: config.apiKeyFor('anthropic') });
  }

  async complete<T>(args: LlmCompleteArgs<T>): Promise<LlmCompletion<T>> {
    const response = await this.client.messages.create(this.requestFor(args));
    return { result: this.parse(response, args.schema), usage: this.usageOf(response.usage) };
  }

  /**
   * FR-AI3: briefs go through the Batch API at 50% of standard rates.
   * Nothing here is latency-sensitive, so the only cost of batching is
   * waiting.
   */
  async completeMany<T>(
    args: Array<LlmCompleteArgs<T> & { key: string }>,
  ): Promise<Array<{ key: string; completion?: LlmCompletion<T>; error?: string }>> {
    if (args.length === 0) return [];

    // LLM_BRIEF_BATCH=false runs the same prompts one at a time, at full
    // price. Useful when a run must not wait on the batch queue.
    if (!args.some((arg) => arg.batch)) return this.sequential(args);

    const batch = await this.client.messages.batches.create({
      requests: args.map((arg) => ({
        custom_id: arg.key,
        params: this.requestFor(arg),
      })),
    });
    this.logger.log(`Submitted batch ${batch.id} with ${args.length} request(s)`);

    const finished = await this.awaitBatch(batch.id);
    if (!finished) {
      // Not an error: the batch is still queued upstream. Leads simply stay
      // un-briefed and the next run picks them up, which is cheap because
      // already-briefed leads are skipped.
      this.logger.warn(`Batch ${batch.id} did not finish within the poll window`);
      return args.map((arg) => ({ key: arg.key, error: 'batch still processing' }));
    }

    const bySchema = new Map(args.map((arg) => [arg.key, arg.schema]));
    const out: Array<{ key: string; completion?: LlmCompletion<T>; error?: string }> = [];

    for await (const entry of await this.client.messages.batches.results(batch.id)) {
      const key = entry.custom_id;
      const schema = bySchema.get(key);
      if (!schema) continue;

      if (entry.result.type !== 'succeeded') {
        out.push({ key, error: `batch result ${entry.result.type}` });
        continue;
      }
      try {
        const message = entry.result.message;
        out.push({
          key,
          completion: {
            result: this.parse(message, schema),
            // Batch pricing is applied by computeCost via the multiplier.
            usage: { ...this.usageOf(message.usage), batch: true },
          },
        });
      } catch (error) {
        out.push({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }

  private async sequential<T>(
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

  private requestFor<T>(args: LlmCompleteArgs<T>): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: args.model,
      max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      // FR-AI4: the shared prefix — ICP, service catalogue, scoring rubric —
      // is identical across thousands of calls, and cache reads cost ~10% of
      // standard input.
      system: args.cacheSystem
        ? [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }]
        : args.system,
      messages: [{ role: 'user', content: args.user }],
      // FR-AI2: constrain generation to the schema rather than parsing prose.
      output_config: {
        format: {
          type: 'json_schema',
          schema: z.toJSONSchema(args.schema, { target: 'draft-2020-12' }) as Record<string, unknown>,
        },
      },
    } as Anthropic.MessageCreateParamsNonStreaming;
  }

  private parse<T>(message: { content: unknown[] }, schema: LlmCompleteArgs<T>['schema']): T {
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } =>
        Boolean(block && typeof block === 'object' && (block as { type?: string }).type === 'text'),
      )
      .map((block) => block.text)
      .join('');

    if (!text.trim()) throw new Error('Anthropic returned no text content');
    return schema.parse(JSON.parse(text));
  }

  private usageOf(usage: AnthropicUsage | undefined): TokenUsage {
    return {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    };
  }

  private async awaitBatch(batchId: string): Promise<boolean> {
    const deadline = Date.now() + BATCH_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const batch = await this.client.messages.batches.retrieve(batchId);
      if (batch.processing_status === 'ended') return true;
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
    }
    return false;
  }
}

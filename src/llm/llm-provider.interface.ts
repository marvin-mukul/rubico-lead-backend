import type { ZodType } from 'zod';
import type { TokenUsage } from '../common/config/price-table.js';

/**
 * Seam 3 of the eight (§4).
 *
 * FR-AI2: output is constrained by a Zod schema at both steps. No free-text
 * parsing anywhere — the schema is passed down to the provider so the model
 * is constrained at generation time, not merely validated afterwards.
 */
export interface LlmCompleteArgs<T> {
  system: string;
  user: string;
  schema: ZodType<T>;
  model: string;
  /** FR-AI3: use the provider's batch endpoint (50% cheaper). */
  batch?: boolean;
  /** FR-AI4: cache the shared system prefix. */
  cacheSystem?: boolean;
  maxTokens?: number;
}

export interface LlmCompletion<T> {
  result: T;
  usage: TokenUsage;
}

export interface LlmProvider {
  readonly name: 'gemini' | 'anthropic';
  complete<T>(args: LlmCompleteArgs<T>): Promise<LlmCompletion<T>>;
  /**
   * Batch several prompts in one submission. Providers without a batch API
   * may fall back to sequential completes; the caller cannot tell, beyond
   * `usage.batch` being false and the cost being higher.
   */
  completeMany<T>(
    args: Array<LlmCompleteArgs<T> & { key: string }>,
  ): Promise<Array<{ key: string; completion?: LlmCompletion<T>; error?: string }>>;
}

export const LLM_CLASSIFY_PROVIDER = Symbol('LLM_CLASSIFY_PROVIDER');
export const LLM_BRIEF_PROVIDER = Symbol('LLM_BRIEF_PROVIDER');

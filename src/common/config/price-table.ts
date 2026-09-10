import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * FR-C9: "Price table lives in config, not code. Rates move."
 *
 * Rates are loaded from a JSON file at boot (PRICE_TABLE_PATH) and validated.
 * Changing a rate is a config edit and a restart — never a code change.
 */

const modelRateSchema = z.object({
  /** USD per 1M fresh input tokens. */
  inputPerMTok: z.number().nonnegative(),
  /** USD per 1M output tokens. */
  outputPerMTok: z.number().nonnegative(),
  /** USD per 1M tokens read from the prompt cache (FR-AI4). */
  cachedInputPerMTok: z.number().nonnegative(),
  /** USD per 1M tokens written to the prompt cache. */
  cacheWritePerMTok: z.number().nonnegative(),
  /** Multiplier applied when the batch endpoint is used (FR-AI3). */
  batchMultiplier: z.number().positive().max(1),
});

export const priceTableSchema = z.record(
  z.string(),
  z.record(z.string(), modelRateSchema),
);

export type ModelRate = z.infer<typeof modelRateSchema>;
export type PriceTableData = z.infer<typeof priceTableSchema>;

/** Token usage as reported by a provider. Referenced by LlmProvider (§4). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** True when the call went through a batch endpoint. */
  batch?: boolean;
}

const PER_MTOK = 1_000_000;

export class PriceTable {
  constructor(private readonly rates: PriceTableData) {}

  static fromFile(path: string): PriceTable {
    const absolute = resolve(process.cwd(), path);
    let contents: string;
    try {
      contents = readFileSync(absolute, 'utf8');
    } catch (cause) {
      throw new Error(
        `Price table not found at ${absolute}. Set PRICE_TABLE_PATH or create the file. (FR-C9)`,
        { cause },
      );
    }

    const parsed = priceTableSchema.safeParse(JSON.parse(contents));
    if (!parsed.success) {
      const lines = parsed.error.issues.map(
        (i) => `  • ${i.path.join('.')}: ${i.message}`,
      );
      throw new Error(`Invalid price table at ${absolute}:\n${lines.join('\n')}`);
    }
    return new PriceTable(parsed.data);
  }

  /** Throws rather than guessing — an unpriced model must not be billable. */
  rateFor(provider: string, model: string): ModelRate {
    const rate = this.rates[provider]?.[model];
    if (!rate) {
      throw new Error(
        `No price configured for ${provider}/${model}. Add it to the price table (FR-C9).`,
      );
    }
    return rate;
  }

  /** Actual USD cost of one call. Used as MeteredClient's `computeCost` (§6.1). */
  compute(provider: string, model: string, usage: TokenUsage): number {
    const rate = this.rateFor(provider, model);
    const cached = usage.cachedInputTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;

    const usd =
      (usage.inputTokens * rate.inputPerMTok +
        usage.outputTokens * rate.outputPerMTok +
        cached * rate.cachedInputPerMTok +
        cacheWrite * rate.cacheWritePerMTok) /
      PER_MTOK;

    return usage.batch ? usd * rate.batchMultiplier : usd;
  }

  /** Providers with at least one priced model. */
  providers(): string[] {
    return Object.keys(this.rates);
  }
}

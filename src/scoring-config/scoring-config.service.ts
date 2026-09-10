import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';

/**
 * The `scoring_config` table — one of the two non-code seams (§4).
 *
 * FR-SC3: weights and half-lives change with no deploy. Values are cached for
 * a few seconds so per-company reads during a pipeline run do not hammer the
 * table, and the cache is dropped immediately on write so a PATCH takes effect
 * on the next call rather than after a TTL.
 *
 * Note the column is a Float, so config is numeric only. Anything list-shaped
 * (allowed countries, industries) is modelled as per-value point keys, e.g.
 * `fit.region.emea`.
 */
const CACHE_TTL_MS = 15_000;

@Injectable()
export class ScoringConfigService {
  private readonly logger = new Logger(ScoringConfigService.name);
  private cache: Map<string, number> | null = null;
  private cachedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<Map<string, number>> {
    if (this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cache;

    const rows = await this.prisma.scoringConfig.findMany({
      select: { key: true, value: true },
    });
    this.cache = new Map(rows.map((row) => [row.key, row.value]));
    this.cachedAt = Date.now();
    return this.cache;
  }

  /** Throws when the key is absent and no fallback is given — a missing weight
   *  must be loud, not silently zero. */
  async get(key: string, fallback?: number): Promise<number> {
    const value = (await this.all()).get(key);
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing scoring_config key "${key}". Run \`npm run db:seed\`.`);
  }

  /** All keys under a dotted prefix, with the prefix stripped. */
  async byPrefix(prefix: string): Promise<Record<string, number>> {
    const dotted = prefix.endsWith('.') ? prefix : `${prefix}.`;
    const out: Record<string, number> = {};
    for (const [key, value] of await this.all()) {
      if (key.startsWith(dotted)) out[key.slice(dotted.length)] = value;
    }
    return out;
  }

  async set(key: string, value: number, updatedBy?: string): Promise<void> {
    await this.prisma.scoringConfig.upsert({
      where: { key },
      create: { key, value, ...(updatedBy ? { updatedBy } : {}) },
      update: { value, ...(updatedBy ? { updatedBy } : {}) },
    });
    this.invalidate();
    this.logger.log(`scoring_config ${key} = ${value} (by ${updatedBy ?? 'unknown'})`);
  }

  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }
}

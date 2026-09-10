import type { ScoringConfigService } from '../../src/scoring-config/index.js';

/**
 * An in-memory ScoringConfigService. The fit filter and scoring functions are
 * meant to be driven entirely by config, so tests set the config explicitly
 * and assert the behaviour follows.
 */
export function fakeScoringConfig(values: Record<string, number>): ScoringConfigService {
  const map = new Map(Object.entries(values));
  return {
    async all() {
      return map;
    },
    async get(key: string, fallback?: number) {
      const value = map.get(key);
      if (value !== undefined) return value;
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing scoring_config key "${key}".`);
    },
    async byPrefix(prefix: string) {
      const dotted = prefix.endsWith('.') ? prefix : `${prefix}.`;
      const out: Record<string, number> = {};
      for (const [key, value] of map) {
        if (key.startsWith(dotted)) out[key.slice(dotted.length)] = value;
      }
      return out;
    },
    async set(key: string, value: number) {
      map.set(key, value);
    },
    invalidate() {},
  } as unknown as ScoringConfigService;
}

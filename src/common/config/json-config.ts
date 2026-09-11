import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ZodType } from 'zod';

/**
 * Structure lives in JSON files; numeric weights live in `scoring_config`.
 *
 * §2.3: `scoring_config.value` is a Float, so anything list- or tree-shaped
 * (the capability map, the archetype taxonomy, trigger families, evidence
 * rules) cannot live there. These load from a `*_PATH` env var and are
 * validated at boot, following the `PRICE_TABLE_PATH` / `config/pricing.json`
 * precedent from P0.
 *
 * A human can still PATCH every numeric knob through
 * `PATCH /api/scoring-config` (FR-SC3); only the shapes are on disk.
 */
export function loadJsonConfig<T>(path: string, schema: ZodType<T>, label: string): T {
  const absolute = resolve(process.cwd(), path);

  let contents: string;
  try {
    contents = readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new Error(`${label} not found at ${absolute}. Check its *_PATH env var.`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`${label} at ${absolute} is not valid JSON.`, { cause });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid ${label} at ${absolute}:\n${lines.join('\n')}`);
  }
  return result.data;
}

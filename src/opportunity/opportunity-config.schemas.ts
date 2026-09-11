import { z } from 'zod';

/**
 * Zod schemas for the four JSON config files (§2.3).
 *
 * Every regex in these files is validated at boot by actually compiling it.
 * A malformed pattern would otherwise fail at the moment a signal happens to
 * reach it — mid-run, on one record, in a job that then reports a partial
 * result. Failing at boot is much cheaper.
 */

const regexSource = z.string().min(1).refine(
  (source) => {
    try {
      new RegExp(source, 'i');
      return true;
    } catch {
      return false;
    }
  },
  { error: 'is not a valid regular expression' },
);

// ── archetypes.json ───────────────────────────────────────────────────────
export const ARCHETYPE_KEYS = [
  'idea_to_product',
  'ai_code_to_production',
  'fix_slowing_software',
  'complex_engineering',
] as const;

export type ArchetypeKey = (typeof ARCHETYPE_KEYS)[number];

export const archetypeConfigSchema = z.object({
  archetypes: z
    .array(
      z.object({
        key: z.enum(ARCHETYPE_KEYS),
        label: z.string().min(1),
        description: z.string().min(1),
        subTypes: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
});

// ── capability-map.json ───────────────────────────────────────────────────
export const capabilityMapSchema = z.object({
  families: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  serviceLines: z.array(z.string().min(1)).min(1),
  segments: z.array(z.string().min(1)).min(1),
});

// ── triggers.json ─────────────────────────────────────────────────────────
export const triggerConfigSchema = z.object({
  _comment: z.string().optional(),
  families: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        /** Candidate archetypes this family suggests. Not a decision — the
         *  classifier decides; the trigger only says "worth asking about". */
        archetypes: z.array(z.enum(ARCHETYPE_KEYS)).min(1),
        patterns: z.array(regexSource).min(1),
      }),
    )
    .min(1),
});

// ── evidence.json ─────────────────────────────────────────────────────────
export const EVIDENCE_LEVELS = ['E0', 'E1', 'E2', 'E3', 'E4'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const ATTRIBUTION_LEVELS = ['A_exact', 'A_matched', 'A_weak'] as const;
export type AttributionLevel = (typeof ATTRIBUTION_LEVELS)[number];

const bandName = z.enum(['immediate', 'high', 'investigate', 'ignore']);

export const evidenceConfigSchema = z.object({
  _comment: z.string().optional(),
  levels: z.record(z.enum(EVIDENCE_LEVELS), z.string()),
  /** Baseline strength per signal type, before any text override. */
  defaultBySignalType: z.record(z.string(), z.enum(EVIDENCE_LEVELS)),
  /** Text patterns that raise (never lower) a signal's strength. */
  overrides: z.array(
    z.object({
      strength: z.enum(EVIDENCE_LEVELS),
      note: z.string().optional(),
      patterns: z.array(regexSource).min(1),
    }),
  ),
  /**
   * The highest band a company may reach given its strongest evidence.
   * This is how "context can never CREATE an opportunity" (§2.5.3) becomes
   * mechanical rather than aspirational.
   */
  bandCeiling: z.record(z.enum(EVIDENCE_LEVELS), bandName),
  attributionLevels: z.record(z.enum(ATTRIBUTION_LEVELS), z.string()),
});

export type ArchetypeConfig = z.infer<typeof archetypeConfigSchema>;
export type CapabilityMap = z.infer<typeof capabilityMapSchema>;
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export type EvidenceConfig = z.infer<typeof evidenceConfigSchema>;

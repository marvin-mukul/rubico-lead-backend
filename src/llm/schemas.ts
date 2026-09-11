import { z } from 'zod';
import { ARCHETYPE_KEYS } from '../opportunity/opportunity-config.schemas.js';

/**
 * FR-AI2: structured output constrained by a Zod schema at both steps. These
 * are the single definition — the provider derives the JSON Schema it sends
 * to the model from the same object that validates the reply.
 */

/**
 * P22: one step of the "why this lead" chain (§2.5.7) — what was observed,
 * what problem it suggests, and which Rubico capability addresses it. Each
 * step carries its own citations so "which claim is unsupported?" is
 * answerable per step, not just for the classification as a whole. FR-AI6's
 * citation enforcement is extended to this chain in ClassifyService.
 */
export const whyThisLeadStepSchema = z.object({
  observation: z.string().min(1).max(200).describe('What the evidence shows, plainly.'),
  implies: z.string().min(1).max(200).describe('What technology problem that suggests.'),
  capability: z
    .string()
    .min(1)
    .max(120)
    .describe('The specific Rubico capability that addresses it (from the capability map).'),
  signal_ids: z
    .array(z.string())
    .min(1)
    .max(6)
    .describe('Ids from the SIGNALS block supporting this step. Must be non-empty.'),
});
export type WhyThisLeadStep = z.infer<typeof whyThisLeadStepSchema>;

/**
 * FR-AI5: the classifier must be *able* to say no, and both refusals discard
 * the record before scoring. They are required booleans rather than optional
 * flags precisely so the model has to take a position.
 *
 * P22 replaces the old five-value `rubico_service` enum with the archetype
 * taxonomy (config/archetypes.json) plus a free capability list and the
 * structured why-this-lead chain — the old enum had no room for
 * `ai_code_to_production`, Rubico's hero offer, and collapsed "why" into two
 * sentences of unstructured `reasoning`.
 */
export const classificationSchema = z.object({
  has_rubico_opportunity: z
    .boolean()
    .describe('False when the company is outside the ICP or needs nothing Rubico sells.'),
  evidence_sufficient: z
    .boolean()
    .describe('False when the signals are too thin to justify a human looking at this.'),
  likely_need: z
    .string()
    .max(300)
    .describe('One sentence on what this company probably needs. Empty when there is no opportunity.'),
  /** One of the four engagement archetypes, or "none" when there is no opportunity. */
  archetype: z.enum([...ARCHETYPE_KEYS, 'none']).describe('The closest archetype, or "none".'),
  /** Free text, but the prompt asks for names drawn from the capability map. */
  rubico_capabilities: z
    .array(z.string().min(1).max(80))
    .max(6)
    .default([])
    .describe('Specific Rubico capabilities that apply, e.g. "Laravel", "AI-generated code hardening".'),
  /** §2.5.7: observed → implies → capability, each step cited. Empty when archetype is "none". */
  why_this_lead: z.array(whyThisLeadStepSchema).max(4).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().max(600).describe('Why, in two sentences at most.'),
  /** Ids of the signals that drove this decision. Validated against the DB. */
  cited_signal_ids: z.array(z.string()).max(20),
});

export type Classification = z.infer<typeof classificationSchema>;

/**
 * Every claim carries a `signal_id`, so FR-AI6 can be enforced in code: a
 * brief with an uncited or invented citation is rejected outright. Making
 * the citation part of the claim's shape — rather than a list at the end —
 * is what makes "which claim is unsupported?" answerable.
 */
export const briefClaimSchema = z.object({
  claim: z.string().min(1).max(400),
  signal_id: z.string().min(1).describe('Must be an id from the SIGNALS block.'),
});

export const briefSchema = z.object({
  headline: z.string().min(1).max(160).describe('One line: who they are and why now.'),
  claims: z.array(briefClaimSchema).min(1).max(8),
  suggested_opening_line: z
    .string()
    .min(1)
    .max(400)
    .describe('FR-AI7: must reference only cited evidence.'),
  /** Ids backing the opening line specifically. */
  opening_line_signal_ids: z.array(z.string()).min(1).max(5),
  risks: z.array(z.string().max(300)).max(4).describe('Reasons this might not be a fit.'),
  confidence: z.enum(['low', 'medium', 'high']),
});

export type Brief = z.infer<typeof briefSchema>;

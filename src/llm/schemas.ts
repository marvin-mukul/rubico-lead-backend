import { z } from 'zod';

/**
 * FR-AI2: structured output constrained by a Zod schema at both steps. These
 * are the single definition — the provider derives the JSON Schema it sends
 * to the model from the same object that validates the reply.
 */

/**
 * FR-AI5: the classifier must be *able* to say no, and both refusals discard
 * the record before scoring. They are required booleans rather than optional
 * flags precisely so the model has to take a position.
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
  rubico_service: z
    .enum([
      'legacy-modernisation',
      'platform-acceleration',
      'product-engineering-pod',
      'data-and-integration',
      'none',
    ])
    .describe('The closest service, or "none".'),
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

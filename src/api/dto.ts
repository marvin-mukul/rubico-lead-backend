import { z } from 'zod';
import { briefSchema, classificationSchema, whyThisLeadStepSchema } from '../llm/schemas.js';
import { EVIDENCE_LEVELS } from '../opportunity/index.js';
import {
  DECISION_ATTRIBUTIONS,
  DECISION_REASON_CODES,
  DECISION_VALUES,
  EVENT_SIGNAL_TYPES,
  LEAD_BANDS,
  LEAD_SORTS,
  LEAD_STATUSES,
  SIGNAL_TYPES,
  SUPPRESSION_REASONS,
} from '../common/domain/index.js';

/**
 * Every `/api/*` DTO, declared once. Zod validates at runtime and the
 * OpenAPI document is generated from these same objects (§9), so the
 * contract the frontend generates types from is the contract the server
 * enforces.
 */

// ── auth ────────────────────────────────────────────────────────────────
export const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

/**
 * No `token` field, deliberately. The session travels as an httpOnly cookie
 * (frontend FR-W8/W-A9), and a token echoed in the body would be readable by
 * the very JavaScript the cookie exists to keep it away from — the rule would
 * hold only for as long as nobody stored what the response handed them.
 */
export const loginResponseSchema = z.object({
  email: z.string(),
  expiresAt: z.iso.datetime(),
});

export const meResponseSchema = z.object({
  email: z.string(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

// ── meta ────────────────────────────────────────────────────────────────

/**
 * The closed vocabularies, as runtime data.
 *
 * Frontend FR-W30: "no component contains a hardcoded list of signal types,
 * bands, or reason codes — all three come from generated types or a backend
 * endpoint", and the requirement it serves is that adding a signal type in
 * Phase 2 "must not require a frontend audit".
 *
 * Generated *types* alone cannot satisfy that. TypeScript unions are erased,
 * so a screen that renders one radio per reason code needs the values at
 * runtime, and the only way to get them from a type is to re-declare the list
 * by hand — the exact thing FR-W30 forbids. Hence an endpoint: the vocabulary
 * is published once, from the same constants the rest of the server enforces,
 * and a new signal type reaches the UI without anyone editing it.
 *
 * Codes only, no display labels. The client derives a label from the code
 * (`wrong_fit` -> "Wrong fit"), which keeps UI copy out of the API and needs
 * no lookup table on either side.
 */
export const metaResponseSchema = z.object({
  bands: z.array(z.enum(LEAD_BANDS)),
  leadStatuses: z.array(z.enum(LEAD_STATUSES)),
  decisionValues: z.array(z.enum(DECISION_VALUES)),
  reasonCodes: z.array(z.enum(DECISION_REASON_CODES)),
  signalTypes: z.array(z.enum(SIGNAL_TYPES)),
  evidenceLevels: z.array(z.enum(EVIDENCE_LEVELS)),
  eventSignalTypes: z.array(z.enum(EVENT_SIGNAL_TYPES)),
  suppressionReasons: z.array(z.enum(SUPPRESSION_REASONS)),
  leadSorts: z.array(z.enum(LEAD_SORTS)),
  decisionAttributions: z.array(z.enum(DECISION_ATTRIBUTIONS)),
});

// ── leads ───────────────────────────────────────────────────────────────
export const leadListQuerySchema = z.object({
  band: z.enum(LEAD_BANDS).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  /**
   * Date range over the *signal's event date*, not `scoredAt`.
   *
   * The question a reviewer asks is "what happened in the last fortnight",
   * and `scoredAt` answers a different one — every lead is rescored nightly,
   * so filtering on it would return everything or nothing depending on when
   * the job last ran.
   */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Leads carrying at least one signal of this type. */
  signalType: z.enum(SIGNAL_TYPES).optional(),
  sort: z.enum(LEAD_SORTS).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const leadSummarySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  canonicalDomain: z.string(),
  companyName: z.string(),
  fitScore: z.number(),
  intentScore: z.number(),
  compoundBonus: z.number(),
  totalScore: z.number(),
  // Enumerated, not `z.string()`. These are closed sets and the server only
  // ever returns a member — widening them here would publish a contract that
  // says otherwise, and frontend FR-W30 forbids the client re-declaring the
  // list it was not told. Same reasoning for every enum below.
  band: z.enum(LEAD_BANDS),
  status: z.enum(LEAD_STATUSES),
  likelyNeed: z.string().nullable(),
  // P22: replaces the old five-value rubico_service enum — see archetypes.json.
  archetype: z.string().nullable(),
  opportunityKey: z.string(),
  confidence: z.string().nullable(),
  scoredAt: z.iso.datetime(),
});

export const leadListResponseSchema = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  leads: z.array(leadSummarySchema),
});

/**
 * FR-B16: contributions arrive with decay already applied. The frontend
 * renders them; it never recomputes a score.
 */
export const contributionSchema = z.object({
  signalId: z.string(),
  type: z.enum(SIGNAL_TYPES),
  eventDate: z.iso.datetime(),
  ageDays: z.number(),
  baseWeight: z.number(),
  halfLifeDays: z.number(),
  // P20: the evidence axis. These were being SENT and not declared, so the
  // frontend's generated types could not see them — an under-declared
  // contract is as broken as a wrong one, just harder to notice. Without
  // them a reviewer cannot tell why a weight-15 signal contributed 3.7.
  evidenceStrength: z.enum(EVIDENCE_LEVELS),
  evidenceMultiplier: z.number(),
  contribution: z.number(),
  counted: z.boolean(),
});

export const evidenceSchema = z.object({
  signalId: z.string(),
  type: z.enum(SIGNAL_TYPES),
  eventDate: z.iso.datetime(),
  sourceName: z.string(),
  sourceUrl: z.string(),
  excerpt: z.string().nullable(),
});

export const leadDetailResponseSchema = leadSummarySchema.extend({
  /**
   * The real shapes, not `z.unknown()`.
   *
   * These are stored as Prisma Json columns, which is why they were typed as
   * unknown — but the LLM schemas that produced them are right here, and the
   * writer validates against them before persisting. Publishing `unknown`
   * told the frontend nothing, and frontend FR-W13 ("every factual claim must
   * be visibly traceable to a source URL") cannot be built against it: the
   * client would have to re-declare the claim shape by hand to reach
   * `signal_id`, which is exactly what FR-W7 forbids.
   */
  brief: briefSchema.nullable(),
  llmClassification: classificationSchema.nullable(),
  // P22: the why-this-lead chain (§2.5.7) — observation -> implies ->
  // capability, each step cited. Empty when there is no confirmed archetype.
  rubicoCapabilities: z.array(z.string()).nullable(),
  whyThisLead: z.array(whyThisLeadStepSchema).nullable(),
  bandReason: z.string().optional(),
  contributions: z.array(contributionSchema),
  evidence: z.array(evidenceSchema),
  company: z.object({
    id: z.string(),
    canonicalDomain: z.string(),
    name: z.string(),
    country: z.string().nullable(),
    region: z.string().nullable(),
    headcountBand: z.string().nullable(),
    industry: z.string().nullable(),
    detectedStack: z.unknown().nullable(),
    legacyFlags: z.unknown().nullable(),
    suppressionReason: z.enum(SUPPRESSION_REASONS).nullable(),
  }),
  decisions: z.array(
    z.object({
      id: z.string(),
      user: z.string(),
      decision: z.enum(DECISION_VALUES),
      reasonCode: z.enum(DECISION_REASON_CODES),
      attribution: z.enum(DECISION_ATTRIBUTIONS),
      notes: z.string().nullable(),
      scoreAtDecision: z.number(),
      decidedAt: z.iso.datetime(),
    }),
  ),
});

export const decisionBodySchema = z.object({
  decision: z.enum(DECISION_VALUES),
  reasonCode: z.enum(DECISION_REASON_CODES),
  notes: z.string().max(2000).optional(),
  /**
   * Defaults to `builder` — the conservative direction. M4 and M5 count only
   * management-attributed decisions, so an omitted attribution understates
   * the headline metric rather than inflating it.
   */
  attribution: z.enum(DECISION_ATTRIBUTIONS).default('builder'),
});

export const decisionResponseSchema = z.object({
  leadId: z.string(),
  status: z.enum(DECISION_VALUES),
  scoreAtDecision: z.number(),
  attribution: z.enum(DECISION_ATTRIBUTIONS),
  decidedAt: z.iso.datetime(),
});

// ── companies ───────────────────────────────────────────────────────────
export const companyDetailResponseSchema = z.object({
  id: z.string(),
  canonicalDomain: z.string(),
  name: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  headcountBand: z.string().nullable(),
  industry: z.string().nullable(),
  detectedStack: z.unknown().nullable(),
  legacyFlags: z.unknown().nullable(),
  atsProvider: z.string().nullable(),
  atsSlug: z.string().nullable(),
  suppressionReason: z.enum(SUPPRESSION_REASONS).nullable(),
  firstSeenAt: z.iso.datetime(),
  lastEnrichedAt: z.iso.datetime().nullable(),
  signals: z.array(evidenceSchema),
});

// ── contacts ────────────────────────────────────────────────────────────
export const contactListQuerySchema = z.object({ leadId: z.string().min(1) });

export const contactSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  seniority: z.string().nullable(),
  email: z.string().nullable(),
  emailStatus: z.string().nullable(),
  source: z.string(),
  creditCost: z.number(),
  resolvedAt: z.iso.datetime(),
});

export const contactListResponseSchema = z.object({ contacts: z.array(contactSchema) });

export const createContactBodySchema = z.object({
  /** Required: FR-C5 is enforced against this lead's status. */
  leadId: z.string().min(1),
  name: z.string().min(1).max(200),
  role: z.string().max(200).optional(),
  seniority: z.string().max(100).optional(),
  email: z.email().optional(),
});

// ── scoring config ──────────────────────────────────────────────────────
export const scoringConfigResponseSchema = z.object({
  config: z.array(
    z.object({
      key: z.string(),
      value: z.number(),
      updatedAt: z.iso.datetime(),
      updatedBy: z.string().nullable(),
    }),
  ),
  /**
   * Frontend FR-W19: the settings screen must warn that a change takes effect
   * at the next nightly rescore, and show when the last one ran.
   *
   * Without this the warning is unfalsifiable — "changes apply at the next
   * rescore" means nothing to someone who cannot tell whether the rescore has
   * run since 2026-08. `null` when no rescore has ever completed, which is
   * itself the answer to "why has nothing changed".
   */
  lastRescoreAt: z.iso.datetime().nullable(),
});

export const scoringConfigPatchSchema = z.object({
  updates: z
    .array(z.object({ key: z.string().min(1).max(200), value: z.number() }))
    .min(1)
    .max(100),
});

// ── metrics ─────────────────────────────────────────────────────────────
export const metricsRangeQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const decisionTotalsSchema = z.object({
  approved: z.number(),
  rejected: z.number(),
  approvalRate: z.number(),
  meanScoreApproved: z.number().nullable(),
  meanScoreRejected: z.number().nullable(),
});

export const funnelResponseSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  m1_signalsIngested: z.number(),
  m2_companiesDiscovered: z.number(),
  m3_passedFitFilter: z.number(),
  m4_classified: z.number(),
  m5_discardedByClassifier: z.number(),
  m6_leadsScored: z.number(),
  m7_briefsGenerated: z.number(),
  m8_decisions: decisionTotalsSchema.extend({
    /**
     * FR-W18: management- and builder-attributed decisions, separately. M4
     * and M5 count only the former, and the Day-30 review needs that split
     * visible without a database query.
     */
    byAttribution: z.object({
      management: decisionTotalsSchema,
      builder: decisionTotalsSchema,
    }),
  }),
  byBand: z.record(z.string(), z.number()),
});

export const spendResponseSchema = z.object({
  monthToDateUsd: z.number(),
  todayUsd: z.number(),
  monthlyCapUsd: z.number(),
  byProvider: z.array(z.object({ provider: z.string(), usdCost: z.number() })),
  qualifiedOpportunities: z.number(),
  costPerQualifiedOpportunityUsd: z.number().nullable(),
});

// ── digest (internal) ───────────────────────────────────────────────────
export const digestQuerySchema = z.object({
  date: z.iso.date().optional(),
});

export const digestResponseSchema = z.object({
  date: z.string(),
  counts: z.object({
    immediate: z.number(),
    high: z.number(),
    investigate: z.number(),
  }),
  leads: z.array(
    z.object({
      id: z.string(),
      canonicalDomain: z.string(),
      companyName: z.string(),
      band: z.string(),
      totalScore: z.number(),
      likelyNeed: z.string().nullable(),
      archetype: z.string().nullable(),
      headline: z.string().nullable(),
      topEvidenceUrl: z.string().nullable(),
    }),
  ),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;
export type DecisionBody = z.infer<typeof decisionBodySchema>;
export type CreateContactBody = z.infer<typeof createContactBodySchema>;
export type ScoringConfigPatch = z.infer<typeof scoringConfigPatchSchema>;
export type MetricsRangeQuery = z.infer<typeof metricsRangeQuerySchema>;
export type DigestQuery = z.infer<typeof digestQuerySchema>;
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

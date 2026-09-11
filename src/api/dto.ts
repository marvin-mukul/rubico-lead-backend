import { z } from 'zod';
import {
  DECISION_REASON_CODES,
  DECISION_VALUES,
  LEAD_BANDS,
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

// ── leads ───────────────────────────────────────────────────────────────
export const leadListQuerySchema = z.object({
  band: z.enum(LEAD_BANDS).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
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
  brief: z.unknown().nullable(),
  llmClassification: z.unknown().nullable(),
  // P22: the why-this-lead chain (§2.5.7) — observation -> implies ->
  // capability, each step cited. Empty when there is no confirmed archetype.
  rubicoCapabilities: z.array(z.string()).nullable(),
  whyThisLead: z.unknown().nullable(),
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
});

export const decisionResponseSchema = z.object({
  leadId: z.string(),
  status: z.enum(DECISION_VALUES),
  scoreAtDecision: z.number(),
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
  m8_decisions: z.object({
    approved: z.number(),
    rejected: z.number(),
    approvalRate: z.number(),
    meanScoreApproved: z.number().nullable(),
    meanScoreRejected: z.number().nullable(),
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

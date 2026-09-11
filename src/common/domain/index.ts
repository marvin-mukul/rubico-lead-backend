/**
 * Shared domain vocabulary. These are the string unions that the Prisma schema
 * stores as plain `String` columns (§5 keeps them as strings so a new value is
 * a config change, not a migration).
 */

/**
 * Signal taxonomy.
 *
 * `F-LEG` and `F-PLAT` are standing properties of a company, not events:
 *   F-LEG  — genuinely obsolete, rebuild-worthy stack. Supports a
 *            modernisation pitch.
 *   F-PLAT — a platform Rubico sells work on (WordPress, WooCommerce,
 *            Shopify, Magento 2, Laravel). A capability MATCH and an
 *            opportunity input, NEVER a defect.
 *
 * Keeping them apart is the difference between "we can help you extend this"
 * and "you should throw this away", said to a company on a platform Rubico
 * staffs for.
 */
export const SIGNAL_TYPES = [
  'F-LEG',
  'F-PLAT',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  /** S6 — public procurement notice. A DECLARED requirement, not inferred. */
  'S6',
  /** S7 — press release. A STATED initiative (E2): the org says it is doing the thing. */
  'S7',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** Event signals only — `F-LEG` and `F-PLAT` are standing properties. */
export const EVENT_SIGNAL_TYPES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] as const;
export type EventSignalType = (typeof EVENT_SIGNAL_TYPES)[number];

export const LEAD_BANDS = ['immediate', 'high', 'investigate', 'ignore'] as const;
export type LeadBand = (typeof LEAD_BANDS)[number];

/** Bands that may still spend once the daily guard has tripped (FR-C3). */
export const PRIORITY_BANDS: readonly LeadBand[] = ['immediate', 'high'];

export const LEAD_STATUSES = ['new', 'approved', 'rejected'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * What a reviewer can decide. A subset of `LEAD_STATUSES` — `new` is the
 * absence of a decision, not something anyone can choose.
 */
export const DECISION_VALUES = ['approved', 'rejected'] as const;
export type DecisionValue = (typeof DECISION_VALUES)[number];

/**
 * Whose judgement a decision records (frontend FR-W18, addendum FR-L12).
 *
 * M4 and M5 count only `management`. The Day-30 review is the builder sitting
 * with a management reviewer and recording their verdicts, and a builder's own
 * opinion of their own engine is not evidence — keeping the two apart is what
 * makes the metric mean anything.
 */
export const DECISION_ATTRIBUTIONS = ['management', 'builder'] as const;
export type DecisionAttribution = (typeof DECISION_ATTRIBUTIONS)[number];

/** Sort orders `GET /api/leads` offers (frontend §6.3). */
export const LEAD_SORTS = ['score', 'recency'] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SUPPRESSION_REASONS = [
  'client',
  'competitor',
  'rejected',
  'do-not-contact',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const DECISION_REASON_CODES = [
  'wrong_fit',
  'stale',
  'already_known',
  'no_real_need',
  'bad_contact',
  'good',
  // P23 (A13 — calibratable classification): the original six cannot
  // express "right company, wrong archetype" or "no real technology need",
  // so the trigger rules, capability map and evidence weights had no ground
  // truth to tune against. `wrong_fit` and `no_real_need` remain as
  // deliberately coarse fallbacks when none of these apply.
  'wrong_archetype',
  'no_technology_need',
  'evidence_too_weak',
  'wrong_capability',
  'platform_not_problem',
  'attribution_error',
] as const;
export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export function isEventSignal(type: string): type is EventSignalType {
  return (EVENT_SIGNAL_TYPES as readonly string[]).includes(type);
}

/** Standing properties of a company rather than things that happened. */
export const STANDING_SIGNAL_TYPES = ['F-LEG', 'F-PLAT'] as const;
export type StandingSignalType = (typeof STANDING_SIGNAL_TYPES)[number];

export function isStandingSignal(type: string): type is StandingSignalType {
  return (STANDING_SIGNAL_TYPES as readonly string[]).includes(type);
}

/**
 * Shared domain vocabulary. These are the string unions that the Prisma schema
 * stores as plain `String` columns (§5 keeps them as strings so a new value is
 * a config change, not a migration).
 */

/** Signal taxonomy — `F-LEG` plus the five event signals (parent spec §5). */
export const SIGNAL_TYPES = ['F-LEG', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** Event signals only — `F-LEG` is a standing property, not an event. */
export const EVENT_SIGNAL_TYPES = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type EventSignalType = (typeof EVENT_SIGNAL_TYPES)[number];

export const LEAD_BANDS = ['immediate', 'high', 'investigate', 'ignore'] as const;
export type LeadBand = (typeof LEAD_BANDS)[number];

/** Bands that may still spend once the daily guard has tripped (FR-C3). */
export const PRIORITY_BANDS: readonly LeadBand[] = ['immediate', 'high'];

export const LEAD_STATUSES = ['new', 'approved', 'rejected'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

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
] as const;
export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export function isEventSignal(type: string): type is EventSignalType {
  return (EVENT_SIGNAL_TYPES as readonly string[]).includes(type);
}

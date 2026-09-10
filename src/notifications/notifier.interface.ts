/** Outbound events, backend → n8n (§8.2). */
export const NOTIFICATION_TYPES = [
  /** FR-C2 halt. */
  'cost.cap_breached',
  /** Any job run ends `failed`. */
  'job.failed',
  /** A source has failed 3 consecutive runs (NFR-8 visibility). */
  'source.unavailable',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationSeverity = 'critical' | 'warning' | 'info';

/** The payload shape defined in §8.2. */
export interface NotificationEvent {
  severity: NotificationSeverity;
  type: NotificationType;
  message: string;
  context: Record<string, unknown>;
  /** ISO 8601. Defaults to now when omitted. */
  occurredAt?: string;
}

export interface Notifier {
  send(event: NotificationEvent): Promise<void>;
}

/** Nest injection token (FR-B1 — providers resolved by token, never `new`ed). */
export const NOTIFIER = Symbol('NOTIFIER');

import { createHash } from 'node:crypto';
import type { SignalType } from '../common/domain/index.js';

/**
 * `Signal.dedupeHash` (§5) — unique, and that uniqueness IS the dedupe
 * mechanism behind acceptance criterion A2.
 *
 * The hash covers the *semantic identity* of an event: which company, what
 * kind of event, on what day, about what. It deliberately excludes
 * `sourceUrl`, `sourceName`, `excerpt` and the raw payload — those describe
 * who reported it, and including any of them would give one funding round
 * four rows when four outlets cover it.
 *
 * Pure function: no I/O.
 */

export interface DedupeIdentity {
  companyId: string;
  type: SignalType;
  eventDate: Date;
  subject: string;
}

/** UTC calendar day. Report timestamps vary; the day of the event does not. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Lowercase, strip accents and punctuation, collapse whitespace. Outlets
 * phrase the same event differently ("Series A" / "series-a" / "Series  A."),
 * and those must not become distinct signals.
 */
export function normaliseSubject(subject: string): string {
  return subject
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Separator is a character that cannot appear in any normalised part, so the
 * boundaries between fields cannot be shifted by crafted input.
 */
const SEPARATOR = '|';

export function dedupeHash(identity: DedupeIdentity): string {
  const parts = [
    identity.companyId,
    identity.type,
    dayKey(identity.eventDate),
    normaliseSubject(identity.subject),
  ];
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex');
}

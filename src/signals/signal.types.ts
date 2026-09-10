import type { SignalType } from '../common/domain/index.js';

/**
 * What a SignalSource emits (§4). Company resolution happens downstream, so a
 * source reports the domain it saw and never touches the database.
 */
export interface RawSignal {
  /** Any spelling; `resolveCanonicalDomain` normalises it. */
  domain: string;
  companyName: string;
  type: SignalType;
  /**
   * The date the event happened — NOT the date it was reported. Dedupe buckets
   * on this, so two outlets covering one funding round must agree on it or
   * they will produce two signals.
   */
  eventDate: Date;
  sourceUrl: string;
  sourceName: string;
  excerpt?: string;
  /**
   * The semantic identity of the event: what happened, independent of who
   * reported it. Two outlets covering the same Series A must produce the same
   * subject (e.g. `series-a`), or dedupe cannot work.
   */
  subject: string;
  /** Full upstream payload, stored in `Signal.raw` as evidence (A3/A7). */
  raw: unknown;
}

export type { SignalType };

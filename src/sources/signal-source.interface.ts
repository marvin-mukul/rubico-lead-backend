import type { SignalType } from '../common/domain/index.js';
import type { RawSignal } from '../signals/index.js';

/**
 * Seam 1 of the eight (§4). A source knows how to talk to one upstream system
 * and nothing else: it does not resolve companies, touch the database, or
 * decide what is worth keeping.
 */
export interface SignalSource {
  /** Registry key, e.g. `sec-edgar`. The job is `ingest.<name>`. */
  readonly name: string;
  readonly signalTypes: SignalType[];
  fetch(since: Date): Promise<RawSignal[]>;
}

/** Multi-provider token — every source binds to this (FR-B1). */
export const SIGNAL_SOURCE = Symbol('SIGNAL_SOURCE');

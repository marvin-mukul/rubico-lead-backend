export { SignalsModule } from './signals.module.js';
export { SignalRepository } from './signal.repository.js';
export { CompoundService } from './compound.service.js';
export { dedupeHash, normaliseSubject } from './dedupe-hash.js';
export type { DedupeIdentity } from './dedupe-hash.js';
export type { RawSignal } from './signal.types.js';
export type { SignalInsert, InsertOutcome, BatchOutcome } from './signal.repository.js';
export type { CompoundResult } from './compound.service.js';

export { ScoringModule } from './scoring.module.js';
export { ScoringService } from './scoring.service.js';
export { RescoreAllJob, RESCORE_SQL } from './rescore.job.js';
export { score, bandFor, MAX_SCORE } from './score.js';
export { decay, decayAt, ageInDays, MS_PER_DAY } from './decay.js';
export type {
  ScoringParameters,
  ScorableSignal,
  ScoreResult,
  SignalContribution,
  SignalWeight,
} from './score.js';

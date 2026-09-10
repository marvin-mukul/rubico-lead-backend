/**
 * Distinct error classes so the job runner can report a readable
 * `job_runs.error` and callers can tell a cap breach from a budget guard.
 */
export abstract class MeteringError extends Error {
  abstract readonly code: string;
}

/** FR-C2 — the hard per-provider cap. Halts the pipeline; does not degrade. */
export class CapBreachedError extends MeteringError {
  readonly code = 'COST_CAP_BREACHED';

  constructor(
    readonly provider: string,
    readonly mtdUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `${provider} month-to-date spend $${mtdUsd.toFixed(4)} has reached its cap of $${capUsd.toFixed(2)}`,
    );
  }
}

/** FR-C4 — a single lead has burned its pre-approval budget. */
export class LeadBudgetExceededError extends MeteringError {
  readonly code = 'LEAD_BUDGET_EXCEEDED';

  constructor(
    readonly leadId: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Lead ${leadId} has consumed $${spentUsd.toFixed(4)} pre-approval, at or over its budget of $${budgetUsd.toFixed(2)}`,
    );
  }
}

/** FR-C3 — daily budget nearly exhausted; only priority bands may proceed. */
export class DailyBudgetGuardError extends MeteringError {
  readonly code = 'DAILY_BUDGET_GUARD';

  constructor(
    readonly spentTodayUsd: number,
    readonly thresholdUsd: number,
    readonly band: string | undefined,
  ) {
    super(
      `Daily spend $${spentTodayUsd.toFixed(4)} has reached ${thresholdUsd.toFixed(4)} (80% of the daily budget); ` +
        `only bands immediate/high may spend, but this call is for band ${band ?? 'unknown'}`,
    );
  }
}

/** A model with no configured price must never be billed (FR-C9). */
export class UnpricedCallError extends MeteringError {
  readonly code = 'UNPRICED_CALL';
}

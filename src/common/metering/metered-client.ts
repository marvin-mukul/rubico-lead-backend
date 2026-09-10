import { Inject, Injectable, Logger } from '@nestjs/common';
import { NOTIFIER, type Notifier } from '../../notifications/index.js';
import { PRIORITY_BANDS, type LeadBand, type LeadStatus } from '../domain/index.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/index.js';
import {
  CapBreachedError,
  DailyBudgetGuardError,
  LeadBudgetExceededError,
} from './metering.errors.js';
import { SpendRepository } from './spend.repository.js';

/** Fraction of the daily budget at which non-priority spend is cut off (FR-C3). */
const DAILY_GUARD_FRACTION = 0.8;

/**
 * Money here is IEEE-754 doubles summed by Postgres, so exact-boundary
 * comparisons need a tolerance: `1.5 * 0.8` is 1.2000000000000002, and a
 * budget spent to exactly $1.20 would otherwise slip past its own threshold.
 * A tenth of a micro-dollar is far below any real rate.
 */
const USD_EPSILON = 1e-9;

/** True when `amount` has reached `threshold`, tolerant of float drift. */
function atOrAbove(amount: number, threshold: number): boolean {
  return amount >= threshold - USD_EPSILON;
}

export interface MeteredCallArgs<T> {
  provider: string;
  operation: string;
  /** When present, the lead's status and band are read from the database. */
  leadId?: string;
  /** Marks the run failed on a cap breach, per §6.1 step 6. */
  jobRunId?: string;
  /** Pre-flight estimate, used only for logging; billing uses computeCost. */
  estimatedCost: number;
  execute: () => Promise<T>;
  /**
   * Actual cost from the provider's own reported usage.
   *
   * §6.1 writes this as `computeCost: (usage) => ...`. It takes the whole
   * result here so that providers without token usage (HTTP quota, credits)
   * fit the same seam; for an LlmProvider the result *is* `{ result, usage }`.
   */
  computeCost: (result: T) => number;
  /** Billable units recorded on `api_usage`. Defaults to 1. */
  units?: (result: T) => number;
}

/**
 * The single choke point for every billable outbound call (FR-B2).
 *
 * Behaviour follows §6.1 in order:
 *   1. Reject if MTD spend for the provider ≥ its hard cap        (FR-C2)
 *   2. Reject if the lead has consumed its pre-approval budget    (FR-C4)
 *   3. Reject non-priority bands once the daily guard trips       (FR-C3)
 *   4. Execute
 *   5. Write ApiUsage with the ACTUAL cost                        (FR-C1)
 *   6. On a step-1 rejection: alert and fail the job run
 */
@Injectable()
export class MeteredClient {
  private readonly logger = new Logger(MeteredClient.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly spend: SpendRepository,
    private readonly prisma: PrismaService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  async call<T>(args: MeteredCallArgs<T>): Promise<T> {
    const { provider, operation, leadId, jobRunId } = args;

    // ── 1. Hard per-provider cap (FR-C2) ─────────────────────────────────
    const capUsd = this.config.monthlyCapFor(provider);
    const mtdUsd = await this.spend.monthToDateUsd(provider);
    if (atOrAbove(mtdUsd, capUsd)) {
      await this.haltOnCapBreach(provider, mtdUsd, capUsd, jobRunId);
      throw new CapBreachedError(provider, mtdUsd, capUsd);
    }

    const lead = leadId ? await this.loadLead(leadId) : null;

    // ── 2. Per-lead pre-approval budget (FR-C4) ──────────────────────────
    // The budget bounds what may be spent BEFORE a human approves the lead.
    // Once approved, the human has taken the decision and the cap no longer
    // applies — only the provider cap and the daily guard do.
    if (leadId && lead?.status !== 'approved') {
      const budgetUsd = this.config.caps.perLeadUsd;
      const spentUsd = await this.spend.leadSpendUsd(leadId);
      if (atOrAbove(spentUsd, budgetUsd)) {
        throw new LeadBudgetExceededError(leadId, spentUsd, budgetUsd);
      }
    }

    // ── 3. Daily budget guard (FR-C3) ────────────────────────────────────
    // §6.1 reads "If MTD spend ≥ 80% of the daily budget" — comparing a
    // month-to-date figure against a DAILY budget, which would trip
    // permanently a day or two into every month and halt all non-priority
    // work. Implemented as today's spend vs. the daily budget, which is
    // plainly the intent. Flagged rather than silently reinterpreted.
    const thresholdUsd = this.config.caps.dailyUsd * DAILY_GUARD_FRACTION;
    const spentTodayUsd = await this.spend.todayUsd();
    if (atOrAbove(spentTodayUsd, thresholdUsd) && !this.isPriority(lead?.band)) {
      throw new DailyBudgetGuardError(spentTodayUsd, thresholdUsd, lead?.band);
    }

    // ── 4. Execute ───────────────────────────────────────────────────────
    const result = await args.execute();

    // ── 5. Record actual spend (FR-C1 — no exceptions) ───────────────────
    const usdCost = args.computeCost(result);
    const units = args.units?.(result) ?? 1;
    await this.prisma.apiUsage.create({
      data: { provider, operation, units, usdCost, ...(leadId ? { leadId } : {}) },
    });

    this.logger.log(
      `${provider}/${operation} cost $${usdCost.toFixed(6)} ` +
        `(estimated $${args.estimatedCost.toFixed(6)}), provider MTD now $${(mtdUsd + usdCost).toFixed(4)}`,
    );

    return result;
  }

  private isPriority(band: string | null | undefined): boolean {
    return band != null && (PRIORITY_BANDS as readonly string[]).includes(band);
  }

  private async loadLead(
    leadId: string,
  ): Promise<{ status: LeadStatus; band: LeadBand } | null> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { status: true, band: true },
    });
    return lead ? { status: lead.status as LeadStatus, band: lead.band as LeadBand } : null;
  }

  /** §6.1 step 6: alert, and mark the run failed. FR-C2: halt, do not degrade. */
  private async haltOnCapBreach(
    provider: string,
    mtdUsd: number,
    capUsd: number,
    jobRunId?: string,
  ): Promise<void> {
    this.logger.error(
      `HALT: ${provider} MTD $${mtdUsd.toFixed(4)} has reached cap $${capUsd.toFixed(2)}`,
    );

    await this.notifier.send({
      severity: 'critical',
      type: 'cost.cap_breached',
      message: `${provider} MTD spend $${mtdUsd.toFixed(2)} exceeded cap $${capUsd.toFixed(2)}`,
      context: { provider, mtdUsd, capUsd },
    });

    if (jobRunId) {
      await this.prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: new CapBreachedError(provider, mtdUsd, capUsd).message,
        },
      });
    }
  }
}

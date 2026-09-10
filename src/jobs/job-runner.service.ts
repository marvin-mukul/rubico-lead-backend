import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { JobStatus } from '../common/domain/index.js';
import { IdempotencyService } from '../common/idempotency/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { NOTIFIER, type Notifier } from '../notifications/index.js';
import { AdvisoryLockService, type AdvisoryLock } from './advisory-lock.service.js';
import { JobRegistry } from './job.registry.js';
import { MutableJobContext, serializeCounts } from './job.types.js';

export interface TriggerArgs {
  jobName: string;
  idempotencyKey: string;
  triggeredBy: string;
  since?: Date;
  dryRun?: boolean;
}

export interface TriggerResult {
  jobRunId: string;
  jobName: string;
  status: JobStatus;
}

@Injectable()
export class JobRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  /** Detached executions, kept so tests and shutdown can await them. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: JobRegistry,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
    private readonly locks: AdvisoryLockService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  /**
   * FR-B5: returns immediately with a jobRunId. It never blocks on the work —
   * n8n's HTTP nodes time out and ingestion can exceed that.
   */
  async trigger(args: TriggerArgs): Promise<TriggerResult> {
    const { jobName, idempotencyKey, triggeredBy, since, dryRun = false } = args;

    // Throws NotFoundException for an unknown job, before any row is written.
    this.registry.get(jobName);

    // FR-B7 — a replayed key returns the existing run, never a second one.
    const { run, created } = await this.idempotency.claim({
      idempotencyKey,
      jobName,
      triggeredBy,
      params: { ...(since ? { since: since.toISOString() } : {}), dryRun },
    });

    if (!created) {
      return { jobRunId: run.id, jobName, status: run.status as JobStatus };
    }

    // FR-B6 — one run per job name at a time.
    const lock = await this.locks.tryAcquire(`job:${jobName}`);
    if (!lock) {
      const inFlightRun = await this.prisma.jobRun.findFirst({
        where: { jobName, status: 'running' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: 'skipped',
          finishedAt: new Date(),
          error: `Another run of ${jobName} is already in flight`,
        },
      });
      this.logger.log(`Skipped ${jobName}: already running`);
      // FR-B6 wants the in-flight run's id back, so the caller can poll it.
      return { jobRunId: inFlightRun?.id ?? run.id, jobName, status: 'skipped' };
    }

    const execution = this.execute(run.id, jobName, { since, dryRun }, lock);
    this.inFlight.set(run.id, execution);
    void execution.finally(() => this.inFlight.delete(run.id));

    return { jobRunId: run.id, jobName, status: 'queued' };
  }

  /** Await a detached run. Used by tests and by graceful shutdown. */
  async awaitRun(jobRunId: string): Promise<void> {
    await this.inFlight.get(jobRunId);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight.size === 0) return;
    this.logger.log(`Waiting for ${this.inFlight.size} in-flight job run(s)`);
    await Promise.allSettled(this.inFlight.values());
  }

  private async execute(
    jobRunId: string,
    jobName: string,
    options: { since?: Date; dryRun: boolean },
    lock: AdvisoryLock,
  ): Promise<void> {
    const context = new MutableJobContext(
      jobRunId,
      { ...(options.since ? { since: options.since.toISOString() } : {}), dryRun: options.dryRun },
      options.dryRun,
      options.since,
    );

    const startedAt = new Date();
    await this.prisma.jobRun.update({
      where: { id: jobRunId },
      data: { status: 'running', startedAt },
    });

    try {
      await this.registry.get(jobName).run(context);

      await this.prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          counts: serializeCounts(context.counts),
        },
      });
      this.logger.log(
        `${jobName} succeeded in ${Date.now() - startedAt.getTime()}ms ${JSON.stringify(context.counts)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // FR-B9: whatever the handler already committed stays committed. The
      // counts recorded so far describe exactly that work.
      await this.prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          counts: serializeCounts(context.counts),
          error: message,
        },
      });
      this.logger.error(`${jobName} failed: ${message}`);

      // FR-B13: a notification failure must never change the run's outcome —
      // N8nNotifier.send() swallows its own errors.
      await this.notifier.send({
        severity: 'critical',
        type: 'job.failed',
        message: `${jobName} failed: ${message}`,
        context: { jobName, jobRunId, counts: serializeCounts(context.counts) },
      });
    } finally {
      await lock.release();
    }
  }
}

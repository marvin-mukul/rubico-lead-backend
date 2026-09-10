import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import { NOTIFIER, type Notifier } from '../notifications/index.js';

/** §8.2: `source.unavailable` fires after 3 consecutive failed runs (NFR-8). */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Consecutive failures are counted from `job_runs` rather than held in memory,
 * so the count survives a restart and cannot drift from what actually
 * happened. `skipped` runs are ignored — a skipped run is a concurrency
 * outcome, not a source problem.
 */
@Injectable()
export class SourceHealthService {
  private readonly logger = new Logger(SourceHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  async consecutiveFailures(jobName: string): Promise<number> {
    const recent = await this.prisma.jobRun.findMany({
      where: { jobName, status: { in: ['succeeded', 'failed'] } },
      orderBy: { createdAt: 'desc' },
      take: CONSECUTIVE_FAILURE_THRESHOLD,
      select: { status: true },
    });

    let count = 0;
    for (const run of recent) {
      if (run.status !== 'failed') break;
      count++;
    }
    return count;
  }

  /**
   * Call while the run is failing, before the runner records it.
   *
   * The current run's row still says `running`, so it is added to the count
   * here rather than read back — the alternative would be reporting one
   * failure late, every time.
   *
   * Fires exactly at the threshold, not on every failure past it, so a dead
   * source alerts once rather than on every subsequent trigger.
   */
  async reportFailure(sourceName: string, jobName: string, error: string): Promise<void> {
    const failures = (await this.consecutiveFailures(jobName)) + 1;
    if (failures !== CONSECUTIVE_FAILURE_THRESHOLD) return;

    this.logger.error(`${sourceName} has failed ${failures} consecutive runs`);
    await this.notifier.send({
      severity: 'warning',
      type: 'source.unavailable',
      message: `${sourceName} has failed ${failures} consecutive runs: ${error}`,
      context: { source: sourceName, jobName, consecutiveFailures: failures },
    });
  }
}

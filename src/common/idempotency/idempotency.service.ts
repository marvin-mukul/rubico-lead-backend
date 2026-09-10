import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
// Prisma 7's prisma-client generator suffixes model types with `Model`.
import type { JobRunModel as JobRun } from '../../generated/prisma/models.js';
import { PrismaService } from '../prisma/index.js';

export interface ClaimArgs {
  idempotencyKey: string;
  jobName: string;
  triggeredBy: string;
  params?: Prisma.InputJsonValue;
}

export interface ClaimResult {
  run: JobRun;
  /** False when this key had already been claimed — the caller must not re-run. */
  created: boolean;
}

/** Postgres unique-violation, surfaced by Prisma as P2002. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * FR-B7: "If the key already exists in `job_runs`, return the existing run
 * rather than starting a new one."
 *
 * The unique index on `job_runs.idempotency_key` is what makes this safe. The
 * pre-read is only a fast path; the insert is the decision point, so two
 * simultaneous retries of the same key still produce exactly one run.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async claim(args: ClaimArgs): Promise<ClaimResult> {
    const { idempotencyKey, jobName, triggeredBy, params } = args;

    const existing = await this.prisma.jobRun.findUnique({ where: { idempotencyKey } });
    if (existing) {
      this.logger.log(`Replay of ${idempotencyKey} → existing run ${existing.id}`);
      return { run: existing, created: false };
    }

    try {
      const run = await this.prisma.jobRun.create({
        data: {
          idempotencyKey,
          jobName,
          triggeredBy,
          status: 'queued',
          ...(params === undefined ? {} : { params }),
        },
      });
      return { run, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost the race against a concurrent request carrying the same key.
      const run = await this.prisma.jobRun.findUniqueOrThrow({ where: { idempotencyKey } });
      this.logger.log(`Concurrent claim of ${idempotencyKey} → existing run ${run.id}`);
      return { run, created: false };
    }
  }

  /** Lookup without claiming. */
  async find(idempotencyKey: string): Promise<JobRun | null> {
    return this.prisma.jobRun.findUnique({ where: { idempotencyKey } });
  }
}

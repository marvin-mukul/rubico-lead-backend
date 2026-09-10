import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { InternalOnly } from '../common/auth/index.js';
import { IdempotencyKey, RequireIdempotencyKey } from '../common/idempotency/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { ZodValidationPipe } from '../common/validation/index.js';
import { JobRunnerService, type TriggerResult } from './job-runner.service.js';
import { runJobBodySchema, type RunJobBody } from './jobs.dto.js';

/** §8.1 — n8n → backend. Auth is X-Internal-Token. */
@Controller('internal/jobs')
@InternalOnly()
export class JobsController {
  constructor(
    private readonly runner: JobRunnerService,
    private readonly prisma: PrismaService,
  ) {}

  /** FR-B5: 202 Accepted immediately, never blocking on the work. */
  @Post(':jobName/run')
  @HttpCode(202)
  @RequireIdempotencyKey()
  async run(
    @Param('jobName') jobName: string,
    @Body(new ZodValidationPipe(runJobBodySchema)) body: RunJobBody,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<TriggerResult> {
    return this.runner.trigger({
      jobName,
      idempotencyKey,
      triggeredBy: 'n8n',
      ...(body.since ? { since: new Date(body.since) } : {}),
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
    });
  }

  @Get('runs/:jobRunId')
  async status(@Param('jobRunId') jobRunId: string) {
    const run = await this.prisma.jobRun.findUnique({
      where: { id: jobRunId },
      select: {
        status: true,
        startedAt: true,
        finishedAt: true,
        counts: true,
        error: true,
        jobName: true,
      },
    });
    if (!run) throw new NotFoundException(`Job run ${jobRunId} not found`);
    return run;
  }
}

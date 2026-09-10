import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { testConfig } from '../../test/support/config.factory.js';
import { IdempotencyService } from '../common/idempotency/index.js';
import { PrismaService } from '../common/prisma/index.js';
import type { NotificationEvent, Notifier } from '../notifications/index.js';
import { AdvisoryLockService } from './advisory-lock.service.js';
import { JobRegistry } from './job.registry.js';
import { JobRunnerService } from './job-runner.service.js';
import type { JobContext, JobHandler } from './job.types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CapturingNotifier implements Notifier {
  readonly sent: NotificationEvent[] = [];
  async send(event: NotificationEvent): Promise<void> {
    this.sent.push(event);
  }
}

describe('JobRunnerService (§7) [integration]', () => {
  let prisma: PrismaService;
  let registry: JobRegistry;
  let runner: JobRunnerService;
  let notifier: CapturingNotifier;
  const keys: string[] = [];

  const key = (): string => {
    const value = `test-${randomUUID()}`;
    keys.push(value);
    return value;
  };

  const handler = (name: string, run: (ctx: JobContext) => Promise<void>): JobHandler => {
    const job: JobHandler = { name, run };
    registry.register(job);
    return job;
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
  });

  beforeEach(() => {
    registry = new JobRegistry();
    notifier = new CapturingNotifier();
    runner = new JobRunnerService(
      registry,
      new IdempotencyService(prisma),
      prisma,
      new AdvisoryLockService(testConfig()),
      notifier,
    );
  });

  afterAll(async () => {
    if (keys.length) {
      await prisma.jobRun.deleteMany({ where: { idempotencyKey: { in: keys } } });
    }
    await prisma.onModuleDestroy();
  });

  it('rejects an unknown job before writing any row', async () => {
    const idempotencyKey = key();
    await expect(
      runner.trigger({ jobName: 'does.not.exist', idempotencyKey, triggeredBy: 'n8n' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.jobRun.count({ where: { idempotencyKey } })).toBe(0);
  });

  // FR-B5 — the response must not wait for the work.
  it('returns immediately rather than blocking on the work', async () => {
    handler('slow.job', async () => {
      await sleep(400);
    });

    const startedAt = Date.now();
    const result = await runner.trigger({
      jobName: 'slow.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('queued');
    expect(elapsed).toBeLessThan(200);

    await runner.awaitRun(result.jobRunId);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: result.jobRunId } });
    expect(run.status).toBe('succeeded');
  });

  // FR-B6 — a second trigger while running is skipped, and reports the in-flight id.
  it('skips a concurrent trigger and returns the in-flight run id', async () => {
    handler('busy.job', async () => {
      await sleep(400);
    });

    const first = await runner.trigger({
      jobName: 'busy.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });
    await sleep(50); // let the run reach 'running'

    const second = await runner.trigger({
      jobName: 'busy.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });

    expect(second.status).toBe('skipped');
    expect(second.jobRunId).toBe(first.jobRunId);

    await runner.awaitRun(first.jobRunId);
  });

  // FR-B7 — replaying a key returns the same run, and starts nothing new.
  it('returns the existing run for a replayed idempotency key', async () => {
    let runs = 0;
    handler('replay.job', async () => {
      runs++;
    });

    const idempotencyKey = key();
    const first = await runner.trigger({
      jobName: 'replay.job',
      idempotencyKey,
      triggeredBy: 'n8n',
    });
    await runner.awaitRun(first.jobRunId);

    const replay = await runner.trigger({
      jobName: 'replay.job',
      idempotencyKey,
      triggeredBy: 'n8n',
    });

    expect(replay.jobRunId).toBe(first.jobRunId);
    expect(replay.status).toBe('succeeded');
    expect(runs).toBe(1);
    expect(await prisma.jobRun.count({ where: { idempotencyKey } })).toBe(1);
  });

  // FR-B8 — counts are the source for M1–M8.
  it('writes the counts the handler accumulated', async () => {
    handler('counting.job', async (ctx) => {
      ctx.count('fetched', 12);
      ctx.count('deduped', 4);
      ctx.count('filteredOut');
    });

    const result = await runner.trigger({
      jobName: 'counting.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });
    await runner.awaitRun(result.jobRunId);

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: result.jobRunId } });
    expect(run.counts).toEqual({ fetched: 12, deduped: 4, filteredOut: 1 });
  });

  // FR-B9 — a failure keeps the counts for work already done, and alerts.
  it('records a failure with its error, keeps partial counts, and notifies', async () => {
    handler('failing.job', async (ctx) => {
      ctx.count('fetched', 7);
      throw new Error('upstream returned 503');
    });

    const result = await runner.trigger({
      jobName: 'failing.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });
    await runner.awaitRun(result.jobRunId);

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: result.jobRunId } });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('upstream returned 503');
    expect(run.counts).toEqual({ fetched: 7 });
    expect(run.finishedAt).not.toBeNull();

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ type: 'job.failed', severity: 'critical' });
  });

  it('releases the lock after a failure so the next run can start', async () => {
    let attempts = 0;
    handler('flaky.job', async () => {
      attempts++;
      if (attempts === 1) throw new Error('first attempt fails');
    });

    const first = await runner.trigger({
      jobName: 'flaky.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });
    await runner.awaitRun(first.jobRunId);

    const second = await runner.trigger({
      jobName: 'flaky.job',
      idempotencyKey: key(),
      triggeredBy: 'n8n',
    });
    expect(second.status).toBe('queued');
    await runner.awaitRun(second.jobRunId);

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: second.jobRunId } });
    expect(run.status).toBe('succeeded');
    expect(attempts).toBe(2);
  });

  it('passes since and dryRun through to the handler', async () => {
    let seen: { since?: Date; dryRun: boolean } | null = null;
    handler('params.job', async (ctx) => {
      seen = { ...(ctx.since ? { since: ctx.since } : {}), dryRun: ctx.dryRun };
    });

    const since = new Date('2026-09-01T00:00:00.000Z');
    const result = await runner.trigger({
      jobName: 'params.job',
      idempotencyKey: key(),
      triggeredBy: 'manual',
      since,
      dryRun: true,
    });
    await runner.awaitRun(result.jobRunId);

    expect(seen).toEqual({ since, dryRun: true });
  });
});

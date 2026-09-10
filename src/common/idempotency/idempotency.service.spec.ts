import { randomUUID } from 'node:crypto';
import { testConfig } from '../../../test/support/config.factory.js';
import { PrismaService } from '../prisma/index.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * §12: "Idempotency integration test — Same `X-Idempotency-Key` twice → one
 * run, one set of rows."
 *
 * Runs against the real database: the guarantee being tested is a Postgres
 * unique constraint, so an in-memory double would test nothing.
 */
describe('IdempotencyService (FR-B7) [integration]', () => {
  let prisma: PrismaService;
  let idempotency: IdempotencyService;
  const keys: string[] = [];

  const freshKey = (): string => {
    const key = `test-${randomUUID()}`;
    keys.push(key);
    return key;
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    idempotency = new IdempotencyService(prisma);
  });

  afterAll(async () => {
    if (keys.length) {
      await prisma.jobRun.deleteMany({ where: { idempotencyKey: { in: keys } } });
    }
    await prisma.onModuleDestroy();
  });

  it('creates a run on first claim', async () => {
    const key = freshKey();
    const result = await idempotency.claim({
      idempotencyKey: key,
      jobName: 'ingest.sec-edgar',
      triggeredBy: 'n8n',
      params: { since: '2026-09-01T00:00:00Z' },
    });

    expect(result.created).toBe(true);
    expect(result.run.status).toBe('queued');
    expect(result.run.jobName).toBe('ingest.sec-edgar');
  });

  it('returns the same run on replay, without creating a second row', async () => {
    const key = freshKey();
    const first = await idempotency.claim({
      idempotencyKey: key,
      jobName: 'ingest.ats',
      triggeredBy: 'n8n',
    });
    const second = await idempotency.claim({
      idempotencyKey: key,
      jobName: 'ingest.ats',
      triggeredBy: 'n8n',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    const rows = await prisma.jobRun.count({ where: { idempotencyKey: key } });
    expect(rows).toBe(1);
  });

  it('produces exactly one run under concurrent claims of the same key', async () => {
    const key = freshKey();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        idempotency.claim({
          idempotencyKey: key,
          jobName: 'pipeline.run',
          triggeredBy: 'n8n',
        }),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(await prisma.jobRun.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('treats distinct keys as distinct runs', async () => {
    const a = await idempotency.claim({
      idempotencyKey: freshKey(),
      jobName: 'pipeline.run',
      triggeredBy: 'manual',
    });
    const b = await idempotency.claim({
      idempotencyKey: freshKey(),
      jobName: 'pipeline.run',
      triggeredBy: 'manual',
    });

    expect(a.created && b.created).toBe(true);
    expect(a.run.id).not.toBe(b.run.id);
  });

  it('find() returns null for an unknown key', async () => {
    expect(await idempotency.find(`test-${randomUUID()}`)).toBeNull();
  });
});

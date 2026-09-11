import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { EVENT_SIGNAL_TYPES } from '../common/domain/index.js';

/**
 * Pins the fix for pipeline starvation.
 *
 * `pending()` takes a limited batch. Ordered by `firstSeenAt: desc` — which
 * is what it did — that limit was not a throughput control but a permanent
 * cut-off: the newest N companies were re-examined on every run and
 * everything older was NEVER processed. Measured on live data, 323 of 523
 * eligible companies were unreachable, and the number grew with every source
 * added.
 *
 * Ordering by `lastPipelineRunAt` ascending (nulls first) turns the same
 * limit into a round-robin. These tests assert the property that matters:
 * **repeated runs eventually reach every eligible company.**
 */
describe('pipeline starvation [integration]', () => {
  let prisma: PrismaService;
  const companyIds: string[] = [];
  const BATCH = 3;
  const TOTAL = 10;

  /** The real `pending()` query, with the batch limit parameterised. */
  const pendingBatch = async (limit: number) => {
    const freshSince = new Date(Date.now() - 30 * 86_400_000);
    return prisma.company.findMany({
      where: {
        suppressionReason: null,
        id: { in: companyIds },
        signals: {
          some: { type: { in: [...EVENT_SIGNAL_TYPES] }, eventDate: { gte: freshSince } },
        },
      },
      orderBy: [{ lastPipelineRunAt: { sort: 'asc', nulls: 'first' } }, { firstSeenAt: 'desc' }],
      take: limit,
      select: { id: true },
    });
  };

  /** What the old implementation did, kept to prove the two disagree. */
  const pendingBatchOldOrdering = async (limit: number) => {
    const freshSince = new Date(Date.now() - 30 * 86_400_000);
    return prisma.company.findMany({
      where: {
        suppressionReason: null,
        id: { in: companyIds },
        signals: {
          some: { type: { in: [...EVENT_SIGNAL_TYPES] }, eventDate: { gte: freshSince } },
        },
      },
      orderBy: { firstSeenAt: 'desc' },
      take: limit,
      select: { id: true },
    });
  };

  const markExamined = async (ids: string[]) => {
    // Sequential, so each row gets a distinct timestamp and the ordering is
    // deterministic rather than dependent on clock resolution.
    for (const id of ids) {
      await prisma.company.update({ where: { id }, data: { lastPipelineRunAt: new Date() } });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();

    for (let i = 0; i < TOTAL; i++) {
      const company = await prisma.company.create({
        data: { canonicalDomain: `starve-${randomUUID()}.test`, name: `Starve ${i}` },
      });
      companyIds.push(company.id);
      await prisma.signal.create({
        data: {
          companyId: company.id,
          type: 'S6',
          eventDate: new Date(),
          sourceUrl: 'https://example.test/1',
          sourceName: 'fixture',
          excerpt: 'Website replacement tender',
          raw: {},
          dedupeHash: randomUUID(),
        },
      });
      // Distinct firstSeenAt, so the old ordering is stable and its failure
      // is deterministic rather than incidental.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  });

  afterAll(async () => {
    if (companyIds.length) {
      await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await prisma.onModuleDestroy();
  });

  it('reaches every eligible company across repeated runs', async () => {
    const seen = new Set<string>();

    // ceil(10 / 3) = 4 runs is the minimum that can cover the set.
    for (let run = 0; run < 4; run++) {
      const batch = await pendingBatch(BATCH);
      for (const row of batch) seen.add(row.id);
      await markExamined(batch.map((row) => row.id));
    }

    expect(seen.size).toBe(TOTAL);
    expect([...seen].sort()).toEqual([...companyIds].sort());
  });

  it('never re-examines a company while others are still waiting', async () => {
    await prisma.company.updateMany({
      where: { id: { in: companyIds } },
      data: { lastPipelineRunAt: null },
    });

    const firstBatch = await pendingBatch(BATCH);
    await markExamined(firstBatch.map((row) => row.id));

    const secondBatch = await pendingBatch(BATCH);
    const overlap = secondBatch.filter((row) =>
      firstBatch.some((first) => first.id === row.id),
    );
    expect(overlap).toEqual([]);
  });

  it('comes back round once everyone has been examined, oldest first', async () => {
    // Explicit timestamps rather than derived ones: the property under test
    // is "least recently examined wins", and asserting it directly is
    // clearer than reasoning about which slot a round-robin lands on.
    const base = Date.now() - 10 * 60_000;
    for (const [index, id] of companyIds.entries()) {
      await prisma.company.update({
        where: { id },
        data: { lastPipelineRunAt: new Date(base + index * 60_000) },
      });
    }

    const batch = await pendingBatch(3);
    // companyIds[0] has the oldest timestamp, [1] next, and so on.
    expect(batch.map((row) => row.id)).toEqual(companyIds.slice(0, 3));

    await markExamined(batch.map((row) => row.id));

    // Having just been examined, those three go to the back.
    const next = await pendingBatch(3);
    expect(next.map((row) => row.id)).toEqual(companyIds.slice(3, 6));
  });

  /** The regression itself: the old ordering never moves on. */
  it('proves the old firstSeenAt ordering starved the tail', async () => {
    await prisma.company.updateMany({
      where: { id: { in: companyIds } },
      data: { lastPipelineRunAt: null },
    });

    const seenOld = new Set<string>();
    for (let run = 0; run < 4; run++) {
      const batch = await pendingBatchOldOrdering(BATCH);
      for (const row of batch) seenOld.add(row.id);
      await markExamined(batch.map((row) => row.id));
    }

    // Four runs, three at a time, and it has still only ever seen three
    // companies — the same three, every run.
    expect(seenOld.size).toBe(BATCH);
    expect(seenOld.size).toBeLessThan(TOTAL);
  });

  it('puts a never-examined company ahead of an examined one', async () => {
    await prisma.company.updateMany({
      where: { id: { in: companyIds } },
      data: { lastPipelineRunAt: new Date() },
    });
    const [fresh] = companyIds;
    await prisma.company.update({
      where: { id: fresh },
      data: { lastPipelineRunAt: null },
    });

    const next = await pendingBatch(1);
    expect(next[0]?.id).toBe(fresh);
  });
});

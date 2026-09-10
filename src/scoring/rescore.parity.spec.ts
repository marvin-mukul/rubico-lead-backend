import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import { CompoundService } from '../signals/index.js';
import { MutableJobContext } from '../jobs/index.js';
import { RescoreAllJob } from './rescore.job.js';
import { ScoringService } from './scoring.service.js';

/**
 * FR-B11 forces `score.rescore-all` into raw SQL, which duplicates the
 * arithmetic that FR-B16 says should live in exactly one place. Set-based SQL
 * cannot call a TypeScript function, so the duplication is unavoidable — but
 * silent divergence is not.
 *
 * This test runs both implementations over the same rows and fails if they
 * disagree. It is what makes the duplication safe.
 */
describe('score.rescore-all parity with score.ts [integration]', () => {
  let prisma: PrismaService;
  let scoring: ScoringService;
  const companyIds: string[] = [];
  /** Pinned so both implementations are evaluated at the same instant. */
  let clockNow = new Date();
  const rescoreAt = (at: Date) => {
    clockNow = at;
    return new RescoreAllJob(prisma, () => clockNow);
  };

  const DAY = 86_400_000;

  const makeCompany = async (fitScore: number, signals: Array<[string, number]>) => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `parity-${randomUUID()}.test`, name: 'Parity Fixture' },
    });
    companyIds.push(company.id);

    for (const [type, daysAgo] of signals) {
      await prisma.signal.create({
        data: {
          companyId: company.id,
          type,
          eventDate: new Date(Date.now() - daysAgo * DAY),
          sourceUrl: 'https://example.test/x',
          sourceName: 'fixture',
          raw: {},
          dedupeHash: randomUUID(),
        },
      });
    }

    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        fitScore,
        intentScore: 0,
        totalScore: 0,
        band: 'ignore',
        scoredAt: new Date(0),
      },
    });
    return { companyId: company.id, leadId: lead.id, fitScore };
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    const config = new ScoringConfigService(prisma);
    scoring = new ScoringService(prisma, config, new CompoundService(prisma, config));
  });

  afterAll(async () => {
    if (companyIds.length) {
      await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await prisma.onModuleDestroy();
  });

  it('produces the same intentScore, compoundBonus, totalScore and band as score.ts', async () => {
    const fixtures = await Promise.all([
      // A fresh multi-signal company — the ordinary case.
      makeCompany(80, [['S1', 1], ['S2', 5], ['S3', 12]]),
      // Repeats of one type: only the strongest may count.
      makeCompany(60, [['S2', 2], ['S2', 40], ['S2', 120]]),
      // All five event types: compound must cap.
      makeCompany(50, [['S1', 3], ['S2', 4], ['S3', 5], ['S4', 6], ['S5', 7]]),
      // Stale only — FR-SC4 must force `ignore`.
      makeCompany(100, [['S1', 200]]),
      // F-LEG alone: scores something, but is not an event signal.
      makeCompany(90, [['F-LEG', 10]]),
      // No signals at all.
      makeCompany(70, []),
      // Signal just inside the freshness boundary.
      makeCompany(40, [['S1', 29]]),
      // Signal just outside it.
      makeCompany(40, [['S1', 31]]),
    ]);

    // Expected values from the pure TypeScript scorer.
    const now = new Date();
    const expected = new Map<string, Awaited<ReturnType<typeof scoring.scoreCompany>>>();
    for (const f of fixtures) {
      expected.set(f.leadId, await scoring.scoreCompany(f.companyId, f.fitScore, now));
    }

    // Now let the SQL do it, at exactly the same instant.
    await rescoreAt(now).run(new MutableJobContext('parity', {}, false));

    for (const f of fixtures) {
      const actual = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId } });
      const want = expected.get(f.leadId)!;

      expect
        .soft(actual.intentScore, `intentScore for lead ${f.leadId}`)
        .toBeCloseTo(want.intentScore, 6);
      expect.soft(actual.compoundBonus, `compoundBonus for lead ${f.leadId}`).toBe(want.compoundBonus);
      expect.soft(actual.totalScore, `totalScore for lead ${f.leadId}`).toBe(want.totalScore);
      expect.soft(actual.band, `band for lead ${f.leadId}`).toBe(want.band);
    }
  });

  // A4: "Scores decrease overnight when no new signals arrive."
  it('lowers a score as its signals age, with no new signals', async () => {
    const f = await makeCompany(40, [['S1', 1]]);
    await rescoreAt(new Date()).run(new MutableJobContext('parity-a4-1', {}, false));
    const first = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId } });

    // Age the signal by a week without adding anything.
    await prisma.signal.updateMany({
      where: { companyId: f.companyId },
      data: { eventDate: new Date(Date.now() - 8 * DAY) },
    });
    await rescoreAt(new Date()).run(new MutableJobContext('parity-a4-2', {}, false));
    const second = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId } });

    expect(second.intentScore).toBeLessThan(first.intentScore);
    expect(second.totalScore).toBeLessThanOrEqual(first.totalScore);
  });

  it('reports how many leads it touched', async () => {
    const context = new MutableJobContext('parity-count', {}, false);
    await rescoreAt(new Date()).run(context);
    expect(context.counts.scored).toBeGreaterThanOrEqual(companyIds.length);
  });
});

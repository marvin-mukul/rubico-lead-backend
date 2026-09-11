import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';

/**
 * Pins the `pending()` filter's actual current shape.
 *
 * History matters here. Before P16, `leads: { none: { brief: { not: undefined } } }`
 * looked like "no lead with a brief" but Prisma strips `undefined` from
 * filters, so it collapsed to `leads: { none: {} }` — "no leads at all". P16
 * fixed the spelling (`NOT: { brief: { equals: Prisma.DbNull } }`), but the
 * fixed clause still meant a company that ever acquired ONE briefed lead was
 * excluded from `pending()` forever — new signals could never surface a
 * SECOND opportunity at an already-known company (§2.4).
 *
 * P21 removes the `leads` clause from `pending()` entirely: freshness alone
 * decides who gets reprocessed, and `ScoringService.upsertLead`'s per-
 * opportunity composite unique is what stops a stable, already-briefed
 * opportunity from producing duplicate spend (see pipeline-run.spec.ts's
 * "does not re-brief" case for that half of the guarantee). This file pins
 * the half that lives in the SQL: a briefed lead no longer hides a company
 * from `pending()`.
 */
describe('pipeline.run pending() filter [integration]', () => {
  let prisma: PrismaService;
  const companyIds: string[] = [];

  const FRESHNESS_DAYS = 30;

  /** The clause as it appears in pipeline-run.job.ts today (P21). */
  const pendingWhere = (freshSince: Date) => ({
    suppressionReason: null,
    signals: { some: { type: { in: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] }, eventDate: { gte: freshSince } } },
  });

  const makeCompany = async (opts: {
    signalAgeDays?: number;
    lead?: 'none' | 'unbriefed' | 'briefed';
  }): Promise<string> => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `pending-${randomUUID()}.test`, name: 'Pending Fixture' },
    });
    companyIds.push(company.id);

    if (opts.signalAgeDays !== undefined) {
      await prisma.signal.create({
        data: {
          companyId: company.id,
          type: 'S1',
          eventDate: new Date(Date.now() - opts.signalAgeDays * 86_400_000),
          sourceUrl: 'https://example.test/1',
          sourceName: 'fixture',
          raw: {},
          dedupeHash: randomUUID(),
        },
      });
    }

    if (opts.lead && opts.lead !== 'none') {
      await prisma.lead.create({
        data: {
          companyId: company.id,
          fitScore: 10,
          intentScore: 1,
          totalScore: 11,
          band: 'investigate',
          scoredAt: new Date(),
          ...(opts.lead === 'briefed' ? { brief: { headline: 'x' } } : {}),
        },
      });
    }
    return company.id;
  };

  const pendingIds = async (): Promise<Set<string>> => {
    const freshSince = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);
    const rows = await prisma.company.findMany({
      where: { ...pendingWhere(freshSince), id: { in: companyIds } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    if (companyIds.length) {
      await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await prisma.onModuleDestroy();
  });

  it('returns a company with a fresh signal and no lead at all', async () => {
    const id = await makeCompany({ signalAgeDays: 1, lead: 'none' });
    expect((await pendingIds()).has(id)).toBe(true);
  });

  it('P21: still returns a company whose lead already has a brief, as long as its signal is fresh', async () => {
    const id = await makeCompany({ signalAgeDays: 1, lead: 'briefed' });
    // This is the exact case the pre-P21 clause got wrong: a company must
    // keep coming back while it has fresh evidence, so a genuinely new
    // opportunity (a different archetype) is never invisible just because
    // an earlier one was already briefed.
    expect((await pendingIds()).has(id)).toBe(true);
  });

  it('still returns a company whose lead has no brief (the retry path)', async () => {
    const id = await makeCompany({ signalAgeDays: 1, lead: 'unbriefed' });
    expect((await pendingIds()).has(id)).toBe(true);
  });

  it('excludes a company whose only signal is stale', async () => {
    const id = await makeCompany({ signalAgeDays: FRESHNESS_DAYS + 5, lead: 'none' });
    expect((await pendingIds()).has(id)).toBe(false);
  });

  it('keeps excluding suppressed companies and companies with no signals', async () => {
    const suppressed = await makeCompany({ signalAgeDays: 1, lead: 'none' });
    await prisma.company.update({
      where: { id: suppressed },
      data: { suppressionReason: 'competitor' },
    });

    const signalless = await prisma.company.create({
      data: { canonicalDomain: `pending-${randomUUID()}.test`, name: 'No Signals' },
    });
    companyIds.push(signalless.id);

    const pending = await pendingIds();
    expect(pending.has(suppressed)).toBe(false);
    expect(pending.has(signalless.id)).toBe(false);
  });
});

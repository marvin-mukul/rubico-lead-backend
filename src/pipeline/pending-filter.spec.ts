import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Pins the `pending()` filter semantics against Prisma's `undefined` stripping.
 *
 * The bug this guards: `leads: { none: { brief: { not: undefined } } }` looks
 * like "no lead with a brief", but Prisma strips `undefined` from filters, so
 * it collapses to `leads: { none: {} }` — "no leads at all". That capped every
 * company at one Lead for life and silently killed the brief-retry path.
 *
 * Nothing about that failure is visible: no error, no type complaint, and a
 * query that returns plausible-looking rows. Only a test that constructs the
 * distinguishing case can catch it, which is why this file exists.
 */
describe('pipeline.run pending() filter [integration]', () => {
  let prisma: PrismaService;
  const companyIds: string[] = [];

  /** The clause as it appears in pipeline-run.job.ts. */
  const CORRECT = { none: { NOT: { brief: { equals: Prisma.DbNull } } } };
  /** The clause as it was written before P16. */
  const BUGGY = { none: { brief: { not: undefined } } };

  const makeCompany = async (lead: 'none' | 'unbriefed' | 'briefed') => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `pending-${randomUUID()}.test`, name: 'Pending Fixture' },
    });
    companyIds.push(company.id);
    await prisma.signal.create({
      data: {
        companyId: company.id,
        type: 'S1',
        eventDate: new Date(),
        sourceUrl: 'https://example.test/1',
        sourceName: 'fixture',
        raw: {},
        dedupeHash: randomUUID(),
      },
    });
    if (lead !== 'none') {
      await prisma.lead.create({
        data: {
          companyId: company.id,
          fitScore: 10,
          intentScore: 1,
          totalScore: 11,
          band: 'investigate',
          scoredAt: new Date(),
          ...(lead === 'briefed' ? { brief: { headline: 'x' } } : {}),
        },
      });
    }
    return company.id;
  };

  const pendingIds = async (leadsClause: object): Promise<Set<string>> => {
    const rows = await prisma.company.findMany({
      where: {
        suppressionReason: null,
        signals: { some: {} },
        leads: leadsClause,
        id: { in: companyIds },
      },
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

  it('returns a company with no lead, and one whose lead has no brief', async () => {
    const noLead = await makeCompany('none');
    const unbriefed = await makeCompany('unbriefed');
    const briefed = await makeCompany('briefed');

    const pending = await pendingIds(CORRECT);

    expect(pending.has(noLead)).toBe(true);
    // The case the bug lost: a lead exists but its brief failed, so the
    // company must come back for a retry.
    expect(pending.has(unbriefed)).toBe(true);
    expect(pending.has(briefed)).toBe(false);
  });

  it('proves the old spelling silently meant "no leads at all"', async () => {
    const unbriefed = await makeCompany('unbriefed');

    const buggy = await pendingIds(BUGGY);
    const correct = await pendingIds(CORRECT);

    // Both agree the company has *a* lead; only the fixed clause notices the
    // lead has no brief.
    expect(buggy.has(unbriefed)).toBe(false);
    expect(correct.has(unbriefed)).toBe(true);
  });

  it('keeps excluding suppressed companies and companies with no signals', async () => {
    const suppressed = await makeCompany('none');
    await prisma.company.update({
      where: { id: suppressed },
      data: { suppressionReason: 'competitor' },
    });

    const signalless = await prisma.company.create({
      data: { canonicalDomain: `pending-${randomUUID()}.test`, name: 'No Signals' },
    });
    companyIds.push(signalless.id);

    const pending = await pendingIds(CORRECT);
    expect(pending.has(suppressed)).toBe(false);
    expect(pending.has(signalless.id)).toBe(false);
  });
});

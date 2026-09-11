import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { SignalRepository, type SignalInsert } from './signal.repository.js';
import { EvidenceService, OpportunityConfigService } from '../opportunity/index.js';

/**
 * Acceptance A2: "Re-running any ingestion job three times creates zero
 * duplicate rows." The guarantee is the unique index on `dedupeHash`, so this
 * runs against the real database.
 */
describe('SignalRepository [integration]', () => {
  let prisma: PrismaService;
  let signals: SignalRepository;
  const companyIds: string[] = [];

  const makeCompany = async (): Promise<string> => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `signal-${randomUUID()}.test`, name: 'Signal Fixture' },
    });
    companyIds.push(company.id);
    return company.id;
  };

  /** One event, as four outlets would report it. */
  const asReportedBy = (companyId: string, outlet: string): SignalInsert => ({
    companyId,
    type: 'S1',
    eventDate: new Date('2026-09-01T00:00:00.000Z'),
    subject: 'Series A',
    sourceUrl: `https://${outlet}.test/acme-series-a`,
    sourceName: outlet,
    excerpt: `${outlet} says Acme raised a Series A`,
    raw: { outlet },
  });

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    signals = new SignalRepository(prisma, new EvidenceService(new OpportunityConfigService(testConfig())));
  });

  afterAll(async () => {
    if (companyIds.length) {
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await prisma.onModuleDestroy();
  });

  it('stores one row for one event reported by four outlets', async () => {
    const companyId = await makeCompany();
    const batch = ['techcrunch', 'axios', 'bloomberg', 'reuters'].map((outlet) =>
      asReportedBy(companyId, outlet),
    );

    const outcome = await signals.insertMany(batch);

    expect(outcome).toEqual({ created: 1, deduped: 3 });
    expect(await prisma.signal.count({ where: { companyId } })).toBe(1);
  });

  it('creates zero duplicates when the same batch is ingested three times (A2)', async () => {
    const companyId = await makeCompany();
    const batch = [asReportedBy(companyId, 'techcrunch')];

    const first = await signals.insertMany(batch);
    const second = await signals.insertMany(batch);
    const third = await signals.insertMany(batch);

    expect(first).toEqual({ created: 1, deduped: 0 });
    expect(second).toEqual({ created: 0, deduped: 1 });
    expect(third).toEqual({ created: 0, deduped: 1 });
    expect(await prisma.signal.count({ where: { companyId } })).toBe(1);
  });

  it('returns the existing row id on a replay, not a new one', async () => {
    const companyId = await makeCompany();
    const first = await signals.insert(asReportedBy(companyId, 'techcrunch'));
    const replay = await signals.insert(asReportedBy(companyId, 'axios'));

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.signalId).toBe(first.signalId);
  });

  it('keeps genuinely different events apart', async () => {
    const companyId = await makeCompany();
    await signals.insert(asReportedBy(companyId, 'techcrunch'));
    await signals.insert({ ...asReportedBy(companyId, 'techcrunch'), subject: 'Series B' });
    await signals.insert({ ...asReportedBy(companyId, 'techcrunch'), type: 'S2' });

    expect(await prisma.signal.count({ where: { companyId } })).toBe(3);
  });

  // FR-B9: a failure partway through leaves already-committed work intact.
  it('keeps earlier inserts when a later one fails', async () => {
    const companyId = await makeCompany();
    const good = asReportedBy(companyId, 'techcrunch');
    const broken = { ...good, subject: 'Series C', companyId: 'does-not-exist' };

    await signals.insert(good);
    await expect(signals.insert(broken)).rejects.toThrow();

    expect(await prisma.signal.count({ where: { companyId } })).toBe(1);
  });

  it('preserves the full upstream payload as evidence (A3/A7)', async () => {
    const companyId = await makeCompany();
    const { signalId } = await signals.insert({
      ...asReportedBy(companyId, 'sec'),
      raw: { formType: 'D', accession: '0001-24-000001', amountUsd: 12_000_000 },
    });

    const stored = await prisma.signal.findUniqueOrThrow({ where: { id: signalId } });
    expect(stored.raw).toEqual({
      formType: 'D',
      accession: '0001-24-000001',
      amountUsd: 12000000,
    });
    expect(stored.sourceUrl).toContain('https://');
  });
});

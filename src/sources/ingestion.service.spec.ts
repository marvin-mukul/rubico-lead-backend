import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { CompanyRepository, SuppressionService } from '../companies/index.js';
import { MutableJobContext } from '../jobs/index.js';
import { SignalRepository, type RawSignal } from '../signals/index.js';
import { IngestionService } from './ingestion.service.js';
import { EvidenceService, OpportunityConfigService } from '../opportunity/index.js';

describe('IngestionService [integration]', () => {
  let prisma: PrismaService;
  let ingestion: IngestionService;
  let suppression: SuppressionService;
  const domains: string[] = [];

  const domain = (): string => {
    const value = `ingest-${randomUUID().slice(0, 8)}.test`;
    domains.push(value);
    return value;
  };

  const signal = (overrides: Partial<RawSignal> = {}): RawSignal => ({
    domain: domain(),
    companyName: 'Fixture Co',
    type: 'S1',
    eventDate: new Date('2026-09-01T00:00:00Z'),
    sourceUrl: 'https://sec.gov/filing/1',
    sourceName: 'sec-edgar',
    subject: 'form-d',
    raw: { fixture: true },
    ...overrides,
  });

  const context = () => new MutableJobContext('run-1', {}, false);

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    ingestion = new IngestionService(
      new CompanyRepository(prisma),
      new SignalRepository(prisma, new EvidenceService(new OpportunityConfigService(testConfig()))),
      prisma,
    );
    suppression = new SuppressionService(prisma);
  });

  afterAll(async () => {
    if (domains.length) {
      const companies = await prisma.company.findMany({
        where: { canonicalDomain: { in: domains } },
        select: { id: true },
      });
      const ids = companies.map((c) => c.id);
      await prisma.signal.deleteMany({ where: { companyId: { in: ids } } });
      await prisma.company.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.onModuleDestroy();
  });

  it('creates a company and a signal, counting what it did', async () => {
    const ctx = context();
    await ingestion.ingest([signal()], ctx);
    expect(ctx.counts).toEqual({ fetched: 1 });
  });

  it('counts a second ingestion of the same event as deduped, not fetched twice', async () => {
    const shared = signal();
    const first = context();
    const second = context();

    await ingestion.ingest([shared], first);
    await ingestion.ingest([shared], second);

    expect(first.counts).toEqual({ fetched: 1 });
    expect(second.counts).toEqual({ fetched: 1, deduped: 1 });
  });

  // The SEC case: no resolvable domain means no company can exist.
  it('filters out records with no resolvable domain rather than failing', async () => {
    const ctx = context();
    await ingestion.ingest(
      [
        signal({ domain: '' }),
        signal({ domain: 'someone@gmail.com' }),
        signal({ domain: 'https://boards.greenhouse.io/acme' }),
      ],
      ctx,
    );
    expect(ctx.counts).toEqual({ fetched: 3, filteredOut: 3 });
  });

  it('skips suppressed companies', async () => {
    const target = domain();
    await ingestion.ingest([signal({ domain: target })], context());

    const company = await prisma.company.findUniqueOrThrow({
      where: { canonicalDomain: target },
    });
    await suppression.suppress(company.id, 'competitor');

    const ctx = context();
    await ingestion.ingest([signal({ domain: target, subject: 'form-d-a' })], ctx);
    expect(ctx.counts).toEqual({ fetched: 1, suppressed: 1 });
  });

  // FR-B9: one malformed record must not end the run.
  it('counts a failing record and keeps going', async () => {
    const ctx = context();
    await ingestion.ingest(
      [
        signal(),
        // eventDate is invalid, so the insert throws.
        signal({ eventDate: new Date('not-a-date') }),
        signal(),
      ],
      ctx,
    );
    expect(ctx.counts.fetched).toBe(3);
    expect(ctx.counts.failed).toBe(1);
  });

  it('writes nothing on a dry run', async () => {
    const target = domain();
    const ctx = new MutableJobContext('run-dry', {}, true);
    await ingestion.ingest([signal({ domain: target })], ctx);

    expect(ctx.counts).toEqual({ fetched: 1 });
    expect(await prisma.company.findUnique({ where: { canonicalDomain: target } })).toBeNull();
  });
});

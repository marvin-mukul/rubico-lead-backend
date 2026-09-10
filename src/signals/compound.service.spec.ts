import { randomUUID } from 'node:crypto';
import { fakeScoringConfig } from '../../test/support/scoring-config.fake.js';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { CompoundService } from './compound.service.js';
import { SignalRepository } from './signal.repository.js';

const CONFIG = {
  'compound.windowDays': 90,
  'compound.minDistinctTypes': 2,
  'compound.perExtraType': 5,
  'compound.bonus': 10,
};

describe('CompoundService — bonus arithmetic', () => {
  const service = new CompoundService(
    null as unknown as PrismaService,
    fakeScoringConfig(CONFIG),
  );

  it('awards nothing below the minimum distinct types', async () => {
    expect((await service.bonusFor(0)).bonus).toBe(0);
    expect((await service.bonusFor(1)).bonus).toBe(0);
  });

  it('awards per extra type once the minimum is met', async () => {
    expect((await service.bonusFor(2)).bonus).toBe(5);
    expect((await service.bonusFor(3)).bonus).toBe(10);
  });

  /** §12: "compound bonus caps at +10". */
  it('caps at the configured bonus, even with six signal types', async () => {
    expect((await service.bonusFor(4)).bonus).toBe(10);
    expect((await service.bonusFor(5)).bonus).toBe(10);
    expect((await service.bonusFor(6)).bonus).toBe(10);
  });

  it('follows the configured cap rather than a hard-coded 10', async () => {
    const generous = new CompoundService(
      null as unknown as PrismaService,
      fakeScoringConfig({ ...CONFIG, 'compound.bonus': 25 }),
    );
    expect((await generous.bonusFor(6)).bonus).toBe(25);
  });
});

describe('CompoundService — over real signals [integration]', () => {
  let prisma: PrismaService;
  let signals: SignalRepository;
  let service: CompoundService;
  const companyIds: string[] = [];

  const makeCompany = async (): Promise<string> => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `compound-${randomUUID()}.test`, name: 'Compound Fixture' },
    });
    companyIds.push(company.id);
    return company.id;
  };

  const addSignal = async (companyId: string, type: string, daysAgo: number): Promise<void> => {
    await signals.insert({
      companyId,
      type: type as 'S1',
      eventDate: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      sourceUrl: `https://example.test/${randomUUID()}`,
      sourceName: 'fixture',
      subject: `${type}-${daysAgo}`,
      raw: { fixture: true },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    signals = new SignalRepository(prisma);
    service = new CompoundService(prisma, fakeScoringConfig(CONFIG));
  });

  afterAll(async () => {
    if (companyIds.length) {
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await prisma.onModuleDestroy();
  });

  it('counts distinct types, not repeats of one type', async () => {
    const companyId = await makeCompany();
    await addSignal(companyId, 'S1', 1);
    await addSignal(companyId, 'S1', 2);
    await addSignal(companyId, 'S1', 3);

    const result = await service.evaluate(companyId);
    expect(result.distinctTypes).toBe(1);
    expect(result.bonus).toBe(0);
  });

  it('awards a bonus for two distinct types in the window', async () => {
    const companyId = await makeCompany();
    await addSignal(companyId, 'S1', 5);
    await addSignal(companyId, 'S2', 10);

    const result = await service.evaluate(companyId);
    expect(result.distinctTypes).toBe(2);
    expect(result.types).toEqual(['S1', 'S2']);
    expect(result.bonus).toBe(5);
  });

  it('caps the bonus with all five event types present', async () => {
    const companyId = await makeCompany();
    for (const [index, type] of ['S1', 'S2', 'S3', 'S4', 'S5'].entries()) {
      await addSignal(companyId, type, index + 1);
    }

    const result = await service.evaluate(companyId);
    expect(result.distinctTypes).toBe(5);
    expect(result.bonus).toBe(10);
  });

  it('ignores signals older than the window', async () => {
    const companyId = await makeCompany();
    await addSignal(companyId, 'S1', 5);
    await addSignal(companyId, 'S2', 200); // outside the 90-day window

    const result = await service.evaluate(companyId);
    expect(result.distinctTypes).toBe(1);
    expect(result.bonus).toBe(0);
  });

  // F-LEG is a standing property, not an event — it must not inflate the bonus.
  it('excludes F-LEG from the distinct-type count', async () => {
    const companyId = await makeCompany();
    await addSignal(companyId, 'S1', 3);
    await addSignal(companyId, 'F-LEG', 3);

    const result = await service.evaluate(companyId);
    expect(result.distinctTypes).toBe(1);
    expect(result.types).toEqual(['S1']);
    expect(result.bonus).toBe(0);
  });
});

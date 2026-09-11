import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { SpendRepository } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { MetricsService } from './metrics.service.js';

/**
 * FR-W18 / addendum FR-L12 — the decision split.
 *
 * M4 and M5 count only management-attributed decisions. The Day-30 review is
 * the builder sitting with a management reviewer and recording their
 * verdicts, so both arrive under the same Phase 0 credential and `user`
 * cannot tell them apart. Rolling them together produces a number that looks
 * like external validation and is not, which is worse than having no number.
 */
describe('funnel decision attribution (FR-W18) [integration]', () => {
  let prisma: PrismaService;
  let metrics: MetricsService;
  const companyIds: string[] = [];
  const leadIds: string[] = [];

  const decide = async (
    decision: 'approved' | 'rejected',
    attribution: 'management' | 'builder',
    scoreAtDecision: number,
  ) => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `attr-${randomUUID()}.test`, name: 'Attribution Fixture' },
    });
    companyIds.push(company.id);
    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        fitScore: 10,
        intentScore: 10,
        totalScore: scoreAtDecision,
        band: 'high',
        scoredAt: new Date(),
      },
    });
    leadIds.push(lead.id);
    await prisma.decision.create({
      data: {
        leadId: lead.id,
        user: 'fixture@rubicotech.in',
        decision,
        reasonCode: 'good',
        attribution,
        scoreAtDecision,
      },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    const config = testConfig();
    metrics = new MetricsService(prisma, new SpendRepository(prisma), config);
  });

  afterAll(async () => {
    await prisma.decision.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    await prisma.onModuleDestroy();
  });

  it('reports management and builder decisions separately', async () => {
    const before = await metrics.funnel(metrics.resolveRange());

    await decide('approved', 'management', 90);
    await decide('rejected', 'management', 50);
    await decide('approved', 'builder', 80);

    const after = await metrics.funnel(metrics.resolveRange());
    const delta = (path: 'management' | 'builder', key: 'approved' | 'rejected') =>
      after.m8_decisions.byAttribution[path][key] - before.m8_decisions.byAttribution[path][key];

    expect(delta('management', 'approved')).toBe(1);
    expect(delta('management', 'rejected')).toBe(1);
    expect(delta('builder', 'approved')).toBe(1);
    expect(delta('builder', 'rejected')).toBe(0);
  });

  it('keeps the overall totals alongside the split, not instead of it', async () => {
    const funnel = await metrics.funnel(metrics.resolveRange());
    const { management, builder } = funnel.m8_decisions.byAttribution;

    // "How much reviewing happened" and "how much of it counts" are different
    // questions; the Day-30 review asks both.
    expect(funnel.m8_decisions.approved).toBe(management.approved + builder.approved);
    expect(funnel.m8_decisions.rejected).toBe(management.rejected + builder.rejected);
  });

  /**
   * The default direction matters. An unlabelled decision must understate the
   * headline metric, never inflate it — a builder's own approval quietly
   * counted as management validation is the one error that would make the
   * Day-30 number a lie.
   */
  it('defaults an unlabelled decision to builder', async () => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `attr-${randomUUID()}.test`, name: 'Default Fixture' },
    });
    companyIds.push(company.id);
    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        fitScore: 1,
        intentScore: 1,
        totalScore: 2,
        band: 'ignore',
        scoredAt: new Date(),
      },
    });
    leadIds.push(lead.id);

    const decision = await prisma.decision.create({
      data: {
        leadId: lead.id,
        user: 'fixture@rubicotech.in',
        decision: 'approved',
        reasonCode: 'good',
        scoreAtDecision: 2,
      },
    });

    expect(decision.attribution).toBe('builder');
  });
});

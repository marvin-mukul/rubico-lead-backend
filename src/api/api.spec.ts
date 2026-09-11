import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { testConfig } from '../../test/support/config.factory.js';
import { ContactResolutionGuard, ContactResolutionPolicy } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { ContactsService } from '../contacts/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import { ScoringService } from '../scoring/index.js';
import { CompoundService } from '../signals/index.js';
import { LeadsService } from './leads.service.js';
import { openApiSchema } from './openapi.js';
import { leadListQuerySchema, leadDetailResponseSchema } from './dto.js';
import { OpportunityConfigService } from '../opportunity/index.js';

describe('/api/* surface (§8.3) [integration]', () => {
  let prisma: PrismaService;
  let leads: LeadsService;
  let contacts: ContactsService;
  let policy: ContactResolutionPolicy;
  const companyIds: string[] = [];

  const makeLead = async (status: string, totalScore = 60) => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `api-${randomUUID()}.test`, name: 'API Fixture', industry: 'SaaS' },
    });
    companyIds.push(company.id);
    await prisma.signal.create({
      data: {
        companyId: company.id,
        type: 'S1',
        eventDate: new Date(),
        sourceUrl: 'https://sec.gov/filing/1',
        sourceName: 'sec-edgar',
        excerpt: 'Form D filed',
        raw: {},
        dedupeHash: randomUUID(),
      },
    });
    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        fitScore: 70,
        intentScore: 20,
        totalScore,
        band: 'high',
        status,
        scoredAt: new Date(),
      },
    });
    return { lead, company };
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    const config = new ScoringConfigService(prisma);
    leads = new LeadsService(prisma, new ScoringService(
      prisma,
      config,
      new CompoundService(prisma, config),
      new OpportunityConfigService(testConfig()),
    ));
    policy = new ContactResolutionPolicy(prisma);
    contacts = new ContactsService(prisma, policy);
  });

  afterAll(async () => {
    if (companyIds.length) {
      await prisma.contact.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.decision.deleteMany({ where: { lead: { companyId: { in: companyIds } } } });
      await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await prisma.onModuleDestroy();
  });

  // A3 / FR-B16
  describe('GET /api/leads/:id', () => {
    it('returns contributions with decay applied and evidence with source URLs', async () => {
      const { lead } = await makeLead('new');
      const detail = await leads.detail(lead.id);

      expect(detail.contributions.length).toBeGreaterThan(0);
      expect(detail.contributions[0]).toHaveProperty('contribution');
      expect(detail.contributions[0]).toHaveProperty('ageDays');
      expect(detail.evidence[0].sourceUrl).toContain('https://');
      expect(leadDetailResponseSchema.safeParse(detail).success).toBe(true);
    });

    it('404s for an unknown lead', async () => {
      await expect(leads.detail('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // FR-B3
  describe('POST /api/leads/:id/decision', () => {
    it('captures the score the human actually saw, not a later one', async () => {
      const { lead } = await makeLead('new', 64);

      const result = await leads.decide(lead.id, 'dash@rubico.tech', {
        decision: 'approved',
        reasonCode: 'good',
      });
      expect(result.scoreAtDecision).toBe(64);

      // The nightly rescore moves the lead; the decision must not move with it.
      await prisma.lead.update({ where: { id: lead.id }, data: { totalScore: 12 } });
      const stored = await prisma.decision.findFirstOrThrow({ where: { leadId: lead.id } });
      expect(stored.scoreAtDecision).toBe(64);
    });

    it('updates the lead status', async () => {
      const { lead } = await makeLead('new');
      await leads.decide(lead.id, 'dash@rubico.tech', {
        decision: 'rejected',
        reasonCode: 'wrong_fit',
      });
      const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(updated.status).toBe('rejected');
    });
  });

  // A9 / FR-C5 — the acceptance criterion, both halves.
  describe('contact resolution is unreachable for an unapproved lead (A9)', () => {
    it('is refused by the service assertion', async () => {
      const { lead } = await makeLead('new');
      await expect(
        contacts.create({ leadId: lead.id, name: 'Dana Reed' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused for a rejected lead too', async () => {
      const { lead } = await makeLead('rejected');
      await expect(
        contacts.create({ leadId: lead.id, name: 'Dana Reed' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused by the route guard, before the service is reached', async () => {
      const { lead } = await makeLead('new');
      const guard = new ContactResolutionGuard(policy);
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ params: {}, query: {}, body: { leadId: lead.id } }) }),
      } as never;
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('succeeds once the lead is approved', async () => {
      const { lead } = await makeLead('approved');
      const contact = await contacts.create({
        leadId: lead.id,
        name: 'Dana Reed',
        role: 'CTO',
        email: 'dana@example.com',
      });
      expect(contact.name).toBe('Dana Reed');
      expect(contact.source).toBe('manual');
      expect(contact.creditCost).toBe(0);
    });

    // Both halves exist because a job can call the service without a guard.
    it('the service assertion holds even with no HTTP request involved', async () => {
      const { lead } = await makeLead('new');
      await expect(policy.assertLeadApproved(lead.id)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /api/leads filtering', () => {
    it('filters by band, status and minScore', async () => {
      const { lead } = await makeLead('new', 88);
      const page = await leads.list({ band: 'high', status: 'new', minScore: 80, page: 1, pageSize: 50 });
      expect(page.leads.some((l) => l.id === lead.id)).toBe(true);

      const tooHigh = await leads.list({ minScore: 99, page: 1, pageSize: 50 });
      expect(tooHigh.leads.some((l) => l.id === lead.id)).toBe(false);
    });
  });
});

/** §9 — the OpenAPI document is generated from the Zod schemas, not hand-written. */
describe('OpenAPI generation (§9, FR-B17)', () => {
  it('marks defaulted query parameters optional on input', () => {
    const input = openApiSchema(leadListQuerySchema, 'input') as { required?: string[] };
    expect(input.required ?? []).not.toContain('page');
    expect(input.required ?? []).not.toContain('pageSize');
  });

  it('marks them guaranteed on output, because the server always returns them', () => {
    const output = openApiSchema(leadListQuerySchema, 'output') as { required?: string[] };
    expect(output.required).toContain('page');
  });

  it('emits OpenAPI 3.0 rather than raw JSON Schema', () => {
    expect(JSON.stringify(openApiSchema(leadListQuerySchema))).not.toContain('$schema');
  });
});

/**
 * P8 — the filters §6.3 asks for, which did not exist until the frontend
 * needed them.
 *
 * The date range and signal-type filters constrain the company's SIGNALS, not
 * the lead row, and the distinction is the whole point: `scoredAt` moves every
 * night when the rescore runs, so a "last 14 days" filter over it answers
 * "when did the job last run" rather than "what happened recently".
 */
describe('GET /api/leads — date range, signal type and sort (§6.3) [integration]', () => {
  let prisma: PrismaService;
  let leads: LeadsService;
  const companyIds: string[] = [];

  /** A lead whose only signal is `type`, `ageDays` old. */
  const seed = async (type: string, ageDays: number, totalScore: number) => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `filter-${randomUUID()}.test`, name: 'Filter Fixture' },
    });
    companyIds.push(company.id);
    await prisma.signal.create({
      data: {
        companyId: company.id,
        type,
        eventDate: new Date(Date.now() - ageDays * 86_400_000),
        sourceUrl: 'https://example.test/1',
        sourceName: 'fixture',
        raw: {},
        dedupeHash: randomUUID(),
      },
    });
    return prisma.lead.create({
      data: {
        companyId: company.id,
        fitScore: 10,
        intentScore: totalScore - 10,
        totalScore,
        band: 'high',
        scoredAt: new Date(Date.now() - ageDays * 86_400_000),
      },
    });
  };

  const ymd = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

  let recent: { id: string };
  let old: { id: string };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    const config = new ScoringConfigService(prisma);
    leads = new LeadsService(
      prisma,
      new ScoringService(
        prisma,
        config,
        new CompoundService(prisma, config),
        new OpportunityConfigService(testConfig()),
      ),
    );
    recent = await seed('S2', 2, 71);
    old = await seed('S6', 200, 72);
  });

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    await prisma.onModuleDestroy();
  });

  const ids = async (query: Partial<Parameters<LeadsService['list']>[0]>) => {
    const page = await leads.list({ page: 1, pageSize: 100, sort: 'score', ...query } as never);
    return new Set(page.leads.map((lead) => lead.id));
  };

  it('filters to leads with a signal inside the date range', async () => {
    const inWindow = await ids({ from: ymd(7) });
    expect(inWindow.has(recent.id)).toBe(true);
    expect(inWindow.has(old.id)).toBe(false);
  });

  it('includes the whole of the `to` day, not up to its midnight', async () => {
    // The recent signal is 2 days old; a `to` of exactly that date must
    // include it. A naive `lte` on the parsed date would exclude everything
    // that happened during the day the reviewer asked for.
    const upToThatDay = await ids({ from: ymd(3), to: ymd(2) });
    expect(upToThatDay.has(recent.id)).toBe(true);
  });

  it('filters by signal type', async () => {
    expect((await ids({ signalType: 'S2' })).has(recent.id)).toBe(true);
    expect((await ids({ signalType: 'S2' })).has(old.id)).toBe(false);
    expect((await ids({ signalType: 'S6' })).has(old.id)).toBe(true);
  });

  // Two `some` clauses would match a company with an old S2 and an unrelated
  // recent S6 — which is not what "an S2 in the last fortnight" means.
  it('requires ONE signal to satisfy both the type and the date range', async () => {
    const both = await ids({ signalType: 'S6', from: ymd(7) });
    expect(both.has(old.id)).toBe(false);
    expect(both.has(recent.id)).toBe(false);
  });

  it('sorts by score or by recency', async () => {
    const byScore = await leads.list({ page: 1, pageSize: 100, sort: 'score' } as never);
    const byRecency = await leads.list({ page: 1, pageSize: 100, sort: 'recency' } as never);

    const scorePos = (id: string) => byScore.leads.findIndex((lead) => lead.id === id);
    const recencyPos = (id: string) => byRecency.leads.findIndex((lead) => lead.id === id);

    // `old` outscores `recent` (72 vs 71) but was scored 200 days earlier, so
    // the two orders must disagree about them.
    expect(scorePos(old.id)).toBeLessThan(scorePos(recent.id));
    expect(recencyPos(recent.id)).toBeLessThan(recencyPos(old.id));
  });
});

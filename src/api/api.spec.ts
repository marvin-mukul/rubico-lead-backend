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

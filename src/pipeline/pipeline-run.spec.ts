import { randomUUID } from 'node:crypto';
import { fakeScoringConfig } from '../../test/support/scoring-config.fake.js';
import { testConfig } from '../../test/support/config.factory.js';
import { CapBreachedError } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { FitFilterService } from '../companies/index.js';
import type { EnrichmentService } from '../enrichment/index.js';
import { MutableJobContext } from '../jobs/index.js';
import type { BriefRequest, BriefService, ClassifyService } from '../llm/index.js';
import {
  OpportunityConfigService,
  OpportunityTriggerService,
} from '../opportunity/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import { ScoringService } from '../scoring/index.js';
import { CompoundService } from '../signals/index.js';
import { PipelineRunJob } from './pipeline-run.job.js';

const FIT_CONFIG = {
  'fit.minScore': 10,
  'fit.headcount.default': 0,
  'fit.region.default': 0,
  'fit.country.default': 0,
  'fit.industry.default': 0,
  'fit.industry.saas': 40,
  'fit.signal.legacyStack': 15,
  'fit.signal.atsPresent': 5,
};

describe('pipeline.run (§7.2, FR-B10) [integration]', () => {
  let prisma: PrismaService;
  let scoring: ScoringService;
  const companyIds: string[] = [];

  /** Enrichment is exercised in P9; here it must simply not touch the network. */
  const noopEnrichment = {
    enrichCompany: async () => ({}),
  } as unknown as EnrichmentService;

  const makeCompany = async (industry: string | null, signalCount = 1) => {
    const company = await prisma.company.create({
      data: {
        canonicalDomain: `pipe-${randomUUID()}.test`,
        name: 'Pipeline Fixture',
        industry,
        lastEnrichedAt: new Date(),
      },
    });
    companyIds.push(company.id);
    for (let i = 0; i < signalCount; i++) {
      await prisma.signal.create({
        data: {
          companyId: company.id,
          type: 'S1',
          eventDate: new Date(Date.now() - i * 86400000),
          sourceUrl: 'https://example.test/1',
          sourceName: 'fixture',
          // The trigger gate reads signal text, so a fixture with no excerpt
          // is correctly rejected before reaching the classifier.
          excerpt: 'Legacy CRM replacement and website rebuild',
          raw: {},
          dedupeHash: randomUUID(),
        },
      });
    }
    return company;
  };

  const buildJob = (
    classify: Partial<ClassifyService>,
    briefs: Partial<BriefService> = { generate: async () => [] },
  ) =>
    new PipelineRunJob(
      prisma,
      noopEnrichment,
      new FitFilterService(fakeScoringConfig(FIT_CONFIG)),
      classify as ClassifyService,
      scoring,
      briefs as BriefService,
      new ScoringConfigService(prisma),
      new OpportunityTriggerService(new OpportunityConfigService(testConfig())),
    );

  const keeps = {
    classify: async () => ({
      keep: true,
      classification: {
        has_rubico_opportunity: true,
        evidence_sufficient: true,
        likely_need: 'Modernise',
        archetype: 'fix_slowing_software' as const,
        rubico_capabilities: [],
        why_this_lead: [],
        confidence: 'medium' as const,
        reasoning: 'because',
        cited_signal_ids: [],
      },
    }),
    saveToLead: async () => undefined,
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
    const config = new ScoringConfigService(prisma);
    scoring = new ScoringService(
      prisma,
      config,
      new CompoundService(prisma, config),
      new OpportunityConfigService(testConfig()),
    );
  });

  afterEach(async () => {
    if (companyIds.length) {
      await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.signal.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      companyIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('walks enrich → classify → score → brief and counts every stage (FR-B8)', async () => {
    const company = await makeCompany('SaaS');
    const briefed: BriefRequest[] = [];

    const job = buildJob(keeps, {
      generate: async (requests: BriefRequest[]) => {
        briefed.push(...requests);
        return requests.map((r) => ({ leadId: r.leadId, brief: {} as never }));
      },
    });

    const context = new MutableJobContext('run', {}, false);
    await job.run(context);

    expect(context.counts.classified).toBeGreaterThanOrEqual(1);
    expect(context.counts.scored).toBeGreaterThanOrEqual(1);
    expect(context.counts.briefed).toBeGreaterThanOrEqual(1);
    expect(briefed.some((r) => r.company.id === company.id)).toBe(true);

    const lead = await prisma.lead.findFirst({ where: { companyId: company.id } });
    expect(lead).not.toBeNull();
  });

  it('filters out a company that fails the fit filter, before any LLM call', async () => {
    const company = await makeCompany('Basket Weaving');
    const classified: string[] = [];

    const job = buildJob({
      ...keeps,
      classify: async (c: { id: string }) => {
        classified.push(c.id);
        return keeps.classify();
      },
    } as unknown as Partial<ClassifyService>);

    const context = new MutableJobContext('run', {}, false);
    await job.run(context);

    expect(context.counts.filteredOut).toBeGreaterThanOrEqual(1);
    // Asserted against this fixture rather than a global call count: the dev
    // database also holds companies from live runs, and since P16 those come
    // back as pending whenever their lead has no brief.
    expect(classified).not.toContain(company.id);
  });

  // FR-AI5 / A6 — the refusal must stop the record before it costs anything more.
  it('discards a classifier refusal before scoring, and never briefs it', async () => {
    const company = await makeCompany('SaaS');
    let briefCalls = 0;

    const job = buildJob(
      {
        classify: async () => ({
          keep: false,
          discardReason: 'no_rubico_opportunity',
          classification: {
            has_rubico_opportunity: false,
            evidence_sufficient: true,
            likely_need: '',
            archetype: 'none' as const,
            rubico_capabilities: [],
            why_this_lead: [],
            confidence: 'high' as const,
            reasoning: 'Out of ICP.',
            cited_signal_ids: [],
          },
        }),
        saveToLead: async () => undefined,
      },
      {
        generate: async (requests: BriefRequest[]) => {
          briefCalls += requests.length;
          return [];
        },
      },
    );

    const context = new MutableJobContext('run', {}, false);
    await job.run(context);

    expect(context.counts.discarded).toBeGreaterThanOrEqual(1);
    expect(context.counts.scored).toBeUndefined();
    expect(briefCalls).toBe(0);
    expect(await prisma.lead.findFirst({ where: { companyId: company.id } })).toBeNull();
  });

  // FR-C2 / A5 — a cap breach halts; it does not degrade quietly.
  it('halts the whole run on a cap breach instead of counting it 200 times', async () => {
    for (let i = 0; i < 4; i++) await makeCompany('SaaS');
    let attempts = 0;

    const job = buildJob({
      classify: async () => {
        attempts++;
        throw new CapBreachedError('gemini', 25.04, 25);
      },
      saveToLead: async () => undefined,
    });

    const context = new MutableJobContext('run', {}, false);
    await expect(job.run(context)).rejects.toBeInstanceOf(CapBreachedError);

    // Stopped at the first company, rather than burning through all four.
    expect(attempts).toBe(1);
    expect(context.counts.failed).toBeUndefined();
  });

  // FR-B9 — one bad record must not end the run.
  it('counts a failing company and carries on with the rest', async () => {
    const companies = [await makeCompany('SaaS'), await makeCompany('SaaS'), await makeCompany('SaaS')];
    const poison = companies[1].id;

    const job = buildJob({
      classify: async (company: { id: string }) => {
        if (company.id === poison) throw new Error('classifier exploded');
        return keeps.classify();
      },
      saveToLead: async () => undefined,
    } as unknown as Partial<ClassifyService>);

    const context = new MutableJobContext('run', {}, false);
    await job.run(context);

    // Asserted against these fixtures rather than the global counts: the
    // dev database also holds companies from live source runs, and this test
    // is about isolation, not about how many rows happen to exist.
    expect(context.counts.failed).toBeGreaterThanOrEqual(1);

    const leads = await prisma.lead.findMany({
      where: { companyId: { in: companies.map((c) => c.id) } },
      select: { companyId: true },
    });
    const scored = new Set(leads.map((lead) => lead.companyId));
    expect(scored.has(companies[0].id)).toBe(true);
    expect(scored.has(companies[2].id)).toBe(true);
    expect(scored.has(poison)).toBe(false);
  });

  // Marking a company examined is bookkeeping, and bookkeeping must never
  // take down a run that has already done its real work. A company can be
  // gone by the time the mark happens — deleted, or merged into another
  // domain — and `company.update()` throws on a missing row, aborting the
  // whole batch. `updateMany` no-ops instead.
  it('survives a company disappearing between pending() and the mark', async () => {
    const company = await makeCompany('SaaS');

    const job = buildJob({
      classify: async (subject: { id: string }) => {
        if (subject.id === company.id) {
          await prisma.signal.deleteMany({ where: { companyId: company.id } });
          await prisma.company.delete({ where: { id: company.id } });
        }
        return keeps.classify();
      },
      saveToLead: async () => undefined,
    } as unknown as Partial<ClassifyService>);

    const context = new MutableJobContext('run', {}, false);
    await expect(job.run(context)).resolves.toBeUndefined();
  });

  // P21 (§2.4) — a company already holding a briefed lead for one archetype
  // must still surface a genuinely different opportunity, as a second row.
  it('gives a company a second lead when a new archetype is classified', async () => {
    const company = await makeCompany('SaaS');
    // A DIFFERENT opportunity than the one `keeps.classify()` below returns
    // (`fix_slowing_software`) — this is the case P21 exists for.
    await prisma.lead.create({
      data: {
        companyId: company.id,
        opportunityKey: 'idea_to_product',
        fitScore: 10,
        intentScore: 1,
        totalScore: 11,
        band: 'investigate',
        scoredAt: new Date(),
        brief: { headline: 'already briefed' },
      },
    });

    const job = buildJob(keeps, {
      generate: async (requests: BriefRequest[]) =>
        requests.map((r) => ({ leadId: r.leadId, brief: {} as never })),
    });

    await job.run(new MutableJobContext('run', {}, false));

    const leads = await prisma.lead.findMany({ where: { companyId: company.id } });
    expect(leads).toHaveLength(2);
    expect(leads.map((l) => l.opportunityKey).sort()).toEqual([
      'fix_slowing_software',
      'idea_to_product',
    ]);
  });

  // P21 — re-scoring a stable, already-briefed opportunity must not spend
  // on a second brief: `hadBrief` gates the BriefRequest.
  it('does not re-brief an opportunity that already has one', async () => {
    const company = await makeCompany('SaaS');
    await prisma.lead.create({
      data: {
        companyId: company.id,
        opportunityKey: 'fix_slowing_software',
        fitScore: 10,
        intentScore: 1,
        totalScore: 11,
        band: 'investigate',
        scoredAt: new Date(),
        brief: { headline: 'already briefed' },
      },
    });

    const briefedLeadIds: string[] = [];
    const job = buildJob(keeps, {
      generate: async (requests: BriefRequest[]) => {
        briefedLeadIds.push(...requests.map((r) => r.leadId));
        return requests.map((r) => ({ leadId: r.leadId, brief: {} as never }));
      },
    });

    await job.run(new MutableJobContext('run', {}, false));

    const leads = await prisma.lead.findMany({ where: { companyId: company.id } });
    expect(leads).toHaveLength(1);
    // Scoped to this fixture rather than counting every brief in the batch.
    // The dev database also holds companies from live source runs, and now
    // that `pending()` round-robins, a different 200 of them share this
    // batch — some legitimately needing a first brief. The claim under test
    // is that THIS already-briefed opportunity is not briefed again.
    expect(briefedLeadIds).not.toContain(leads[0].id);
  });

  it('writes nothing on a dry run', async () => {
    const company = await makeCompany('SaaS');
    let classifyCalls = 0;

    const job = buildJob({
      ...keeps,
      classify: async () => {
        classifyCalls++;
        return keeps.classify();
      },
    });

    await job.run(new MutableJobContext('run', {}, true));

    expect(classifyCalls).toBe(0);
    expect(await prisma.lead.findFirst({ where: { companyId: company.id } })).toBeNull();
  });
});

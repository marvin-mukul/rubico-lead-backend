import { randomUUID } from 'node:crypto';
import { testConfig } from '../../../test/support/config.factory.js';
import type { NotificationEvent, Notifier } from '../../notifications/index.js';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/index.js';
import { MeteredClient } from './metered-client.js';
import {
  CapBreachedError,
  DailyBudgetGuardError,
  LeadBudgetExceededError,
} from './metering.errors.js';
import { SpendRepository } from './spend.repository.js';

/**
 * §6.3 — "do this before writing any LLM code".
 *
 * Runs against the real database: caps are enforced from SQL aggregates over
 * `api_usage`, so a mocked repository would prove nothing.
 */
describe('MeteredClient (§6) [integration]', () => {
  let prisma: PrismaService;

  const providers: string[] = [];
  const companyIds: string[] = [];
  const jobRunIds: string[] = [];

  /** A provider name unique to this test, so MTD sums stay isolated. */
  const scopedProvider = (): string => {
    const name = `test-${randomUUID().slice(0, 8)}`;
    providers.push(name);
    return name;
  };

  class CapturingNotifier implements Notifier {
    readonly sent: NotificationEvent[] = [];
    async send(event: NotificationEvent): Promise<void> {
      this.sent.push(event);
    }
  }

  const build = (
    overrides: Partial<Env> = {},
  ): { client: MeteredClient; notifier: CapturingNotifier } => {
    const notifier = new CapturingNotifier();
    // Daily budget parked high unless a test is exercising the daily guard,
    // so unrelated spend from earlier tests cannot trip FR-C3.
    const config = testConfig({ DAILY_CAP_USD: 1_000_000, ...overrides });
    const client = new MeteredClient(config, new SpendRepository(prisma), prisma, notifier);
    return { client, notifier };
  };

  const seedSpend = async (provider: string, usdCost: number): Promise<void> => {
    await prisma.apiUsage.create({
      data: { provider, operation: 'seed', units: 1, usdCost },
    });
  };

  const makeLead = async (band: string, status: string): Promise<string> => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `metering-${randomUUID()}.test`, name: 'Metering Fixture' },
    });
    companyIds.push(company.id);
    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        fitScore: 50,
        intentScore: 10,
        totalScore: 60,
        band,
        status,
        scoredAt: new Date(),
      },
    });
    return lead.id;
  };

  beforeAll(async () => {
    prisma = new PrismaService(testConfig());
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    if (providers.length) {
      await prisma.apiUsage.deleteMany({ where: { provider: { in: providers } } });
      providers.length = 0;
    }
    if (jobRunIds.length) {
      await prisma.jobRun.deleteMany({ where: { id: { in: jobRunIds } } });
      jobRunIds.length = 0;
    }
    if (companyIds.length) {
      await prisma.lead.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.apiUsage.deleteMany({ where: { provider: 'gemini', operation: 'seed' } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      companyIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  // ── FR-C1 ───────────────────────────────────────────────────────────────
  describe('records every call (FR-C1)', () => {
    it('writes ApiUsage with the ACTUAL cost, not the estimate', async () => {
      const provider = scopedProvider();
      const { client } = build();

      const result = await client.call({
        provider,
        operation: 'classify',
        estimatedCost: 0.0002,
        execute: async () => ({ usage: { inputTokens: 1000, outputTokens: 500 } }),
        computeCost: (r) => r.usage.inputTokens * 1e-7 + r.usage.outputTokens * 4e-7,
        units: (r) => r.usage.inputTokens + r.usage.outputTokens,
      });

      expect(result.usage.inputTokens).toBe(1000);

      const rows = await prisma.apiUsage.findMany({ where: { provider } });
      expect(rows).toHaveLength(1);
      expect(rows[0].usdCost).toBeCloseTo(0.0003, 10);
      expect(rows[0].units).toBe(1500);
      expect(rows[0].operation).toBe('classify');
    });

    it('defaults units to 1', async () => {
      const provider = scopedProvider();
      const { client } = build();
      await client.call({
        provider,
        operation: 'enrich',
        estimatedCost: 0,
        execute: async () => 'ok',
        computeCost: () => 0,
      });
      const rows = await prisma.apiUsage.findMany({ where: { provider } });
      expect(rows[0].units).toBe(1);
    });
  });

  // ── §6.3 acceptance test — this is criterion A5 ─────────────────────────
  describe('§6.3 acceptance: cap set to $0.01 halts the pipeline', () => {
    it('halts, alerts, fails the job run, and blocks all further calls', async () => {
      const { client, notifier } = build({ GEMINI_MONTHLY_CAP_USD: 0.01 });

      providers.push('gemini');
      await seedSpend('gemini', 0.011); // month-to-date is now over the cap

      const run = await prisma.jobRun.create({
        data: {
          jobName: 'pipeline.run',
          idempotencyKey: `cap-test-${randomUUID()}`,
          status: 'running',
          triggeredBy: 'manual',
          startedAt: new Date(),
        },
      });
      jobRunIds.push(run.id);

      let executed = 0;
      const attempt = () =>
        client.call({
          provider: 'gemini',
          operation: 'classify',
          jobRunId: run.id,
          estimatedCost: 0.0002,
          execute: async () => {
            executed++;
            return { usage: {} };
          },
          computeCost: () => 0.0002,
        });

      // 1. The pipeline halts.
      await expect(attempt()).rejects.toBeInstanceOf(CapBreachedError);
      expect(executed).toBe(0);

      // 2. A cost.cap_breached payload reaches the n8n alert webhook.
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]).toMatchObject({
        severity: 'critical',
        type: 'cost.cap_breached',
        context: { provider: 'gemini', capUsd: 0.01 },
      });
      expect(notifier.sent[0].message).toMatch(/gemini MTD spend \$0\.01 exceeded cap \$0\.01/);

      // 3. job_runs.status = 'failed' with a readable error.
      const failed = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/has reached its cap/);
      expect(failed.finishedAt).not.toBeNull();

      // 4. No further metered calls execute until the cap is raised.
      await expect(attempt()).rejects.toBeInstanceOf(CapBreachedError);
      await expect(attempt()).rejects.toBeInstanceOf(CapBreachedError);
      expect(executed).toBe(0);
      expect(await prisma.apiUsage.count({ where: { provider: 'gemini', operation: 'classify' } })).toBe(0);
    });

    it('resumes once the cap is raised', async () => {
      providers.push('gemini');
      await seedSpend('gemini', 0.011);

      const blocked = build({ GEMINI_MONTHLY_CAP_USD: 0.01 });
      await expect(
        blocked.client.call({
          provider: 'gemini',
          operation: 'classify',
          estimatedCost: 0,
          execute: async () => 'x',
          computeCost: () => 0,
        }),
      ).rejects.toBeInstanceOf(CapBreachedError);

      const raised = build({ GEMINI_MONTHLY_CAP_USD: 25 });
      await expect(
        raised.client.call({
          provider: 'gemini',
          operation: 'classify',
          estimatedCost: 0,
          execute: async () => 'x',
          computeCost: () => 0.0001,
        }),
      ).resolves.toBe('x');
    });

    it('falls back to the global monthly cap when no provider override is set', async () => {
      const provider = scopedProvider();
      await seedSpend(provider, 30);
      const { client } = build({ MONTHLY_CAP_USD: 25 });
      await expect(
        client.call({
          provider,
          operation: 'brief',
          estimatedCost: 0,
          execute: async () => 'x',
          computeCost: () => 0,
        }),
      ).rejects.toBeInstanceOf(CapBreachedError);
    });
  });

  // ── FR-C4 ───────────────────────────────────────────────────────────────
  describe('per-lead pre-approval budget (FR-C4)', () => {
    it('rejects once an unapproved lead has consumed its budget', async () => {
      const provider = scopedProvider();
      const leadId = await makeLead('investigate', 'new');
      await prisma.apiUsage.create({
        data: { provider, operation: 'classify', units: 1, usdCost: 0.1, leadId },
      });

      const { client } = build({ PER_LEAD_BUDGET_USD: 0.1 });
      await expect(
        client.call({
          provider,
          operation: 'brief',
          leadId,
          estimatedCost: 0.01,
          execute: async () => 'x',
          computeCost: () => 0.01,
        }),
      ).rejects.toBeInstanceOf(LeadBudgetExceededError);
    });

    it('does not apply once the lead is approved — the human has decided', async () => {
      const provider = scopedProvider();
      const leadId = await makeLead('investigate', 'approved');
      await prisma.apiUsage.create({
        data: { provider, operation: 'classify', units: 1, usdCost: 0.5, leadId },
      });

      const { client } = build({ PER_LEAD_BUDGET_USD: 0.1 });
      await expect(
        client.call({
          provider,
          operation: 'brief',
          leadId,
          estimatedCost: 0.01,
          execute: async () => 'x',
          computeCost: () => 0.01,
        }),
      ).resolves.toBe('x');
    });
  });

  // ── FR-C3 ───────────────────────────────────────────────────────────────
  describe('daily budget guard (FR-C3)', () => {
    it('rejects a non-priority band once 80% of the daily budget is spent', async () => {
      const provider = scopedProvider();
      await seedSpend(provider, 1.2); // 80% of 1.5 is 1.2
      const leadId = await makeLead('investigate', 'new');

      const { client } = build({ DAILY_CAP_USD: 1.5, MONTHLY_CAP_USD: 1000 });
      await expect(
        client.call({
          provider,
          operation: 'classify',
          leadId,
          estimatedCost: 0,
          execute: async () => 'x',
          computeCost: () => 0,
        }),
      ).rejects.toBeInstanceOf(DailyBudgetGuardError);
    });

    it('lets immediate and high bands through', async () => {
      const provider = scopedProvider();
      await seedSpend(provider, 1.2);

      const { client } = build({ DAILY_CAP_USD: 1.5, MONTHLY_CAP_USD: 1000 });
      for (const band of ['immediate', 'high']) {
        const leadId = await makeLead(band, 'new');
        await expect(
          client.call({
            provider,
            operation: 'classify',
            leadId,
            estimatedCost: 0,
            execute: async () => 'x',
            computeCost: () => 0,
          }),
        ).resolves.toBe('x');
      }
    });
  });
});

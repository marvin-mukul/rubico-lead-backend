import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { PrismaService } from '../common/prisma/index.js';
import { SignalRepository } from '../signals/index.js';
import type { CompanyModel as Company } from '../generated/prisma/models.js';
import type { Enricher, EnrichmentResult } from './enricher.interface.js';
import { EnrichmentService } from './enrichment.service.js';

/**
 * A12 — "No company on WordPress, WooCommerce, Shopify or Magento 2 produces
 * an F-LEG signal or a modernisation-pitch brief on that basis alone."
 *
 * These are published Rubico service lines. Before P17 the engine flagged
 * wordpress.org itself as having an obsolete stack in need of a rebuild, and
 * a WordPress detection added +15 to fit through `fit.signal.legacyStack`.
 *
 * The criterion must hold for rows already in the database, not only for new
 * ones, so the last test checks the whole table rather than a fixture.
 */
describe('platform is not a defect (A12) [integration]', () => {
  let prisma: PrismaService;
  const companyIds: string[] = [];

  /** An enricher that returns exactly the buckets a test wants. */
  const fixedEnricher = (result: EnrichmentResult): Enricher => ({
    name: 'fixture',
    cost: 'free',
    enrich: async () => result,
  });

  const serviceReturning = (result: EnrichmentResult) =>
    new EnrichmentService([fixedEnricher(result)], prisma, new SignalRepository(prisma));

  const makeCompany = async (): Promise<Company> => {
    const company = await prisma.company.create({
      data: { canonicalDomain: `a12-${randomUUID()}.test`, name: 'A12 Fixture' },
    });
    companyIds.push(company.id);
    return company;
  };

  const signalTypes = async (companyId: string): Promise<string[]> => {
    const rows = await prisma.signal.findMany({
      where: { companyId },
      select: { type: true },
    });
    return rows.map((row) => row.type).sort();
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

  it('raises F-PLAT and never F-LEG for a WordPress site', async () => {
    const company = await makeCompany();
    await serviceReturning({
      detectedStack: { wordpress: true },
      platformFlags: { wordpress: true },
      legacyFlags: {},
    }).enrichCompany(company);

    expect(await signalTypes(company.id)).toEqual(['F-PLAT']);
  });

  it.each(['woocommerce', 'shopify', 'magento2', 'laravel'])(
    'raises F-PLAT and never F-LEG for %s',
    async (platform) => {
      const company = await makeCompany();
      await serviceReturning({
        detectedStack: { [platform]: true },
        platformFlags: { [platform]: true },
        legacyFlags: {},
      }).enrichCompany(company);

      expect(await signalTypes(company.id)).toEqual(['F-PLAT']);
    },
  );

  it('still raises F-LEG for genuinely obsolete markers', async () => {
    const company = await makeCompany();
    await serviceReturning({
      legacyFlags: { 'aspnet-webforms': true },
      platformFlags: {},
    }).enrichCompany(company);

    expect(await signalTypes(company.id)).toEqual(['F-LEG']);
  });

  it('holds both when a serviced platform runs an obsolete dependency', async () => {
    const company = await makeCompany();
    await serviceReturning({
      detectedStack: { woocommerce: true },
      platformFlags: { woocommerce: true },
      legacyFlags: { 'jquery-old': true },
    }).enrichCompany(company);

    // A WooCommerce store on jQuery 1.x is a capability match AND a real
    // modernisation lead. Neither fact cancels the other.
    expect(await signalTypes(company.id)).toEqual(['F-LEG', 'F-PLAT']);
  });

  it('clears a standing signal when its markers go away (FR-S5)', async () => {
    const company = await makeCompany();
    await serviceReturning({
      legacyFlags: { 'aspnet-webforms': true },
      platformFlags: {},
    }).enrichCompany(company);
    expect(await signalTypes(company.id)).toEqual(['F-LEG']);

    // They modernised. Re-verification must withdraw the flag, so the engine
    // stops pitching a rebuild to a company that already did one.
    const reloaded = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    await serviceReturning({ legacyFlags: {}, platformFlags: {} }).enrichCompany(reloaded);
    expect(await signalTypes(company.id)).toEqual([]);
  });

  it('never writes a platform marker into legacyFlags', async () => {
    const company = await makeCompany();
    await serviceReturning({
      detectedStack: { shopify: true },
      platformFlags: { shopify: true },
      legacyFlags: {},
    }).enrichCompany(company);

    const stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    const legacy = Object.keys((stored.legacyFlags ?? {}) as Record<string, unknown>);
    expect(legacy).not.toContain('shopify');
    expect(Object.keys((stored.detectedStack ?? {}) as Record<string, unknown>)).toContain('shopify');
  });

  /**
   * The acceptance query itself, across every row already in the database.
   *
   * It inspects the F-LEG signal's OWN markers (`Signal.raw`, which holds the
   * legacyFlags it was raised from) rather than the company's detectedStack.
   * A12 says "on that basis alone", and a WooCommerce store running jQuery
   * 1.x correctly carries F-LEG — just not because of WooCommerce. Checking
   * detectedStack would flag that legitimate case and miss the point.
   */
  it('holds for the whole table, including pre-existing rows', async () => {
    const offenders = await prisma.$queryRaw<Array<{ domain: string; markers: string }>>`
      SELECT c."canonicalDomain" AS domain, s.raw::text AS markers
      FROM "Signal" s
      JOIN "Company" c ON c.id = s."companyId"
      WHERE s.type = 'F-LEG'
        AND (s.raw ? 'wordpress'
          OR s.raw ? 'woocommerce'
          OR s.raw ? 'shopify'
          OR s.raw ? 'magento2'
          OR s.raw ? 'laravel'
          OR s.raw ? 'drupal-current')
    `;
    expect(offenders).toEqual([]);
  });
});

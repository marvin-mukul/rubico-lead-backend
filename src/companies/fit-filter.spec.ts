import { fakeScoringConfig } from '../../test/support/scoring-config.fake.js';
import { FitFilterService, slugify } from './fit-filter.service.js';

/** §12: "Fit filter unit tests — config-driven rules behave as configured." */
describe('FitFilterService', () => {
  const BASE = {
    'fit.minScore': 40,
    'fit.headcount.default': 0,
    'fit.headcount.51-200': 25,
    'fit.region.default': 0,
    'fit.region.emea': 15,
    'fit.country.default': 0,
    'fit.country.gb': 10,
    'fit.industry.default': 0,
    'fit.industry.saas': 20,
    'fit.signal.legacyStack': 15,
    'fit.signal.atsPresent': 5,
  };

  const COMPANY = {
    headcountBand: '51-200',
    region: 'EMEA',
    country: 'GB',
    industry: 'SaaS',
  };

  const filterWith = (overrides: Record<string, number> = {}) =>
    new FitFilterService(fakeScoringConfig({ ...BASE, ...overrides }));

  it('sums the configured points for each attribute', async () => {
    const result = await filterWith().evaluate(COMPANY);
    expect(result.fitScore).toBe(70); // 25 + 15 + 10 + 20
    expect(result.passes).toBe(true);
  });

  // The point of the test group: the rules live in config, not in this class.
  it('flips the outcome when the threshold changes, with no code change', async () => {
    const company = { headcountBand: '51-200' }; // 25 points only

    expect((await filterWith({ 'fit.minScore': 20 }).evaluate(company)).passes).toBe(true);
    expect((await filterWith({ 'fit.minScore': 40 }).evaluate(company)).passes).toBe(false);
  });

  it('flips the outcome when an attribute is reweighted', async () => {
    const company = { industry: 'SaaS' };
    expect((await filterWith({ 'fit.minScore': 15 }).evaluate(company)).passes).toBe(true);
    expect(
      (await filterWith({ 'fit.minScore': 15, 'fit.industry.saas': 5 }).evaluate(company)).passes,
    ).toBe(false);
  });

  it('falls back to the dimension default for unknown and missing values', async () => {
    const unknown = await filterWith({ 'fit.industry.default': 3 }).evaluate({
      industry: 'Basket Weaving',
    });
    const missing = await filterWith({ 'fit.industry.default': 3 }).evaluate({});
    expect(unknown.fitScore).toBe(3);
    expect(missing.fitScore).toBe(3);
  });

  it('adds the legacy-stack and ATS bonuses only when present', async () => {
    const without = await filterWith().evaluate(COMPANY);
    const withBoth = await filterWith().evaluate({
      ...COMPANY,
      hasLegacyFlags: true,
      atsProvider: 'greenhouse',
    });
    expect(withBoth.fitScore - without.fitScore).toBe(20); // 15 + 5
  });

  it('reports contributions so a score is explainable (A3)', async () => {
    const result = await filterWith().evaluate({ ...COMPANY, atsProvider: 'lever' });
    expect(result.contributions).toEqual([
      { key: 'fit.headcount.51-200', points: 25 },
      { key: 'fit.region.emea', points: 15 },
      { key: 'fit.country.gb', points: 10 },
      { key: 'fit.industry.saas', points: 20 },
      { key: 'fit.signal.atsPresent', points: 5 },
    ]);
    expect(result.contributions.reduce((s, c) => s + c.points, 0)).toBe(result.fitScore);
  });

  it('clamps to 0..100', async () => {
    const high = await filterWith({ 'fit.industry.saas': 500 }).evaluate(COMPANY);
    expect(high.fitScore).toBe(100);

    const low = await filterWith({ 'fit.industry.saas': -500 }).evaluate(COMPANY);
    expect(low.fitScore).toBe(0);
  });

  it('is case- and punctuation-insensitive about attribute values', async () => {
    const a = await filterWith().evaluate({ region: 'EMEA' });
    const b = await filterWith().evaluate({ region: '  emea  ' });
    expect(a.fitScore).toBe(b.fitScore);
    expect(a.fitScore).toBe(15);
  });
});

describe('slugify', () => {
  it('produces predictable config keys', () => {
    expect(slugify('51-200')).toBe('51-200');
    expect(slugify('E-Commerce & Retail')).toBe('e-commerce-retail');
    expect(slugify('  APAC  ')).toBe('apac');
  });
});

import { ageInDays, decay } from './decay.js';
import { bandFor, score, type ScorableSignal, type ScoringParameters } from './score.js';

/**
 * §12: the scoring unit tests. "Pure functions, cheap, and a silent decay bug
 * survives to the Day-30 review and makes the engine look broken."
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-10T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const PARAMS: ScoringParameters = {
  weights: {
    S1: { weight: 25, halfLifeDays: 30 },
    S2: { weight: 20, halfLifeDays: 45 },
    S3: { weight: 15, halfLifeDays: 30 },
    S4: { weight: 12, halfLifeDays: 60 },
    S5: { weight: 30, halfLifeDays: 21 },
    'F-LEG': { weight: 15, halfLifeDays: 365 },
  },
  fitWeight: 0.5,
  intentWeight: 1,
  bands: { immediate: 70, high: 50, investigate: 30 },
  eventSignalFreshnessDays: 30,
};

const signal = (type: ScorableSignal['type'], days: number, id = `${type}-${days}`) => ({
  id,
  type,
  eventDate: daysAgo(days),
});

describe('decay (§12)', () => {
  it('at t=0 equals the base weight', () => {
    expect(decay(25, 30, 0)).toBe(25);
  });

  it('at one half-life equals half the base weight', () => {
    expect(decay(25, 30, 30)).toBeCloseTo(12.5, 10);
    expect(decay(20, 45, 45)).toBeCloseTo(10, 10);
  });

  it('halves again at each further half-life', () => {
    expect(decay(25, 30, 60)).toBeCloseTo(6.25, 10);
    expect(decay(25, 30, 90)).toBeCloseTo(3.125, 10);
  });

  it('treats a non-positive half-life as no decay rather than NaN', () => {
    expect(decay(25, 0, 100)).toBe(25);
    expect(decay(25, -5, 100)).toBe(25);
  });

  it('never rewards a future-dated event', () => {
    expect(ageInDays(new Date(NOW.getTime() + 5 * DAY), NOW)).toBe(0);
    expect(decay(25, 30, -10)).toBe(25);
  });
});

describe('score (§12)', () => {
  // §12: "180-day funding contributes < 1"
  it('gives a 180-day funding signal a contribution under 1', () => {
    const result = score({ fitScore: 0, signals: [signal('S1', 180)], compoundBonus: 0, now: NOW }, PARAMS);
    expect(result.contributions[0].contribution).toBeLessThan(1);
    expect(result.contributions[0].contribution).toBeCloseTo(0.390625, 6);
  });

  // §12: "FR-SC4 (no event signal under 30 days → band `ignore` regardless of fit)"
  it('bands ignore when no event signal is fresh, however good the fit', () => {
    const result = score(
      { fitScore: 100, signals: [signal('S1', 45)], compoundBonus: 10, now: NOW },
      PARAMS,
    );
    expect(result.band).toBe('ignore');
    expect(result.bandReason).toMatch(/FR-SC4/);
  });

  it('bands ignore for a perfect fit with no signals at all', () => {
    const result = score({ fitScore: 100, signals: [], compoundBonus: 0, now: NOW }, PARAMS);
    expect(result.band).toBe('ignore');
  });

  it('does not let F-LEG alone satisfy the freshness rule', () => {
    // F-LEG is a standing property, not an event: a legacy stack and nothing
    // happening is not a lead.
    const result = score(
      { fitScore: 100, signals: [signal('F-LEG', 1)], compoundBonus: 0, now: NOW },
      PARAMS,
    );
    expect(result.band).toBe('ignore');
  });

  it('bands normally once a fresh event signal exists', () => {
    const result = score(
      { fitScore: 80, signals: [signal('S1', 1), signal('S2', 5)], compoundBonus: 5, now: NOW },
      PARAMS,
    );
    expect(result.bandReason).toBeUndefined();
    expect(result.band).toBe('immediate');
  });

  it('counts only the strongest signal of each type', () => {
    const result = score(
      {
        fitScore: 0,
        signals: [signal('S2', 1, 'fresh'), signal('S2', 100, 'stale'), signal('S2', 200, 'ancient')],
        compoundBonus: 0,
        now: NOW,
      },
      PARAMS,
    );
    expect(result.contributions.filter((c) => c.counted).map((c) => c.signalId)).toEqual(['fresh']);
    // Not 3x the weight — repetition of one signal type does not compound.
    expect(result.intentScore).toBeCloseTo(decay(20, 45, 1), 10);
  });

  it('still reports uncounted signals so the score stays explainable (A3)', () => {
    const result = score(
      { fitScore: 0, signals: [signal('S2', 1), signal('S2', 100)], compoundBonus: 0, now: NOW },
      PARAMS,
    );
    expect(result.contributions).toHaveLength(2);
    expect(result.contributions.filter((c) => c.counted)).toHaveLength(1);
  });

  it('sums across distinct types', () => {
    const result = score(
      { fitScore: 0, signals: [signal('S1', 0), signal('S2', 0), signal('S3', 0)], compoundBonus: 0, now: NOW },
      PARAMS,
    );
    expect(result.intentScore).toBeCloseTo(25 + 20 + 15, 10);
  });

  it('applies the configured fit and intent weights', () => {
    const result = score(
      { fitScore: 60, signals: [signal('S1', 0)], compoundBonus: 0, now: NOW },
      PARAMS,
    );
    // 60 * 0.5 + 25 * 1 = 55
    expect(result.totalScore).toBe(55);
  });

  it('adds the compound bonus and clamps the total to 100', () => {
    const result = score(
      { fitScore: 100, signals: [signal('S1', 0), signal('S5', 0)], compoundBonus: 10, now: NOW },
      PARAMS,
    );
    expect(result.totalScore).toBe(100);
  });

  it('gives an unconfigured signal type zero rather than NaN', () => {
    const sparse: ScoringParameters = { ...PARAMS, weights: { S1: { weight: 25, halfLifeDays: 30 } } };
    const result = score(
      { fitScore: 0, signals: [signal('S1', 0), signal('S4', 0)], compoundBonus: 0, now: NOW },
      sparse,
    );
    expect(result.intentScore).toBe(25);
    expect(result.totalScore).toBe(25);
  });
});

describe('bandFor', () => {
  const bands = { immediate: 70, high: 50, investigate: 30 };

  it('is inclusive at each threshold', () => {
    expect(bandFor(70, bands)).toBe('immediate');
    expect(bandFor(50, bands)).toBe('high');
    expect(bandFor(30, bands)).toBe('investigate');
  });

  it('drops a band just below each threshold', () => {
    expect(bandFor(69, bands)).toBe('high');
    expect(bandFor(49, bands)).toBe('investigate');
    expect(bandFor(29, bands)).toBe('ignore');
  });
});

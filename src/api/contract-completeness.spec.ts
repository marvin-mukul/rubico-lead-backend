import { score, type ScoringParameters } from '../scoring/score.js';
import { contributionSchema, leadDetailResponseSchema, leadSummarySchema } from './dto.js';

/**
 * Guards the *under*-declared contract.
 *
 * A DTO that omits a field the server actually sends is a quiet failure: the
 * response is still correct, every test still passes, and the only casualty
 * is the client, whose generated types simply do not mention it. That is how
 * `evidenceStrength` and `evidenceMultiplier` — added to the scorer in P20 —
 * reached the frontend as invisible fields, leaving a reviewer no way to see
 * why a weight-15 signal contributed 3.7.
 *
 * The check runs the real scorer and compares the keys it produces against
 * the keys the DTO declares. It cannot be satisfied by remembering.
 */
describe('response DTOs declare everything the server sends', () => {
  const params: ScoringParameters = {
    weights: { S1: { weight: 20, halfLifeDays: 30 }, 'F-LEG': { weight: 15, halfLifeDays: 365 } },
    fitWeight: 1,
    intentWeight: 1,
    bands: { immediate: 80, high: 60, investigate: 40 },
    eventSignalFreshnessDays: 30,
    evidenceMultipliers: { E0: 0.25, E1: 0.5, E2: 1, E3: 1.5, E4: 2 },
    evidenceCeilings: {
      E0: 'ignore',
      E1: 'investigate',
      E2: 'high',
      E3: 'immediate',
      E4: 'immediate',
    },
  };

  it('contributionSchema names every field the scorer emits', () => {
    const result = score(
      {
        fitScore: 50,
        compoundBonus: 0,
        signals: [{ id: 'sig_1', type: 'S1', eventDate: new Date(), evidenceStrength: 'E2' }],
      },
      params,
    );

    const emitted = Object.keys(result.contributions[0]!).sort();
    const declared = Object.keys(contributionSchema.shape).sort();

    // Both directions. Missing keys hide data from the client; extra keys
    // promise data that never arrives.
    const undeclared = emitted.filter((key) => !declared.includes(key));
    const unsent = declared.filter((key) => !emitted.includes(key));

    expect(undeclared, `sent but not declared: ${undeclared.join(', ')}`).toEqual([]);
    expect(unsent, `declared but never sent: ${unsent.join(', ')}`).toEqual([]);
  });

  /**
   * The detail response extends the summary, so a field added to one is
   * silently absent from the other only if someone extends the wrong object.
   */
  it('lead detail is a superset of lead summary', () => {
    const summary = Object.keys(leadSummarySchema.shape);
    const detail = Object.keys(leadDetailResponseSchema.shape);
    const missing = summary.filter((key) => !detail.includes(key));

    expect(missing, `on the list row but not the detail: ${missing.join(', ')}`).toEqual([]);
  });
});

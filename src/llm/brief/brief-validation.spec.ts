import { validateBrief } from './brief-validation.js';
import type { Brief } from '../schemas.js';

const KNOWN = new Set(['sig_1', 'sig_2', 'sig_3']);

const brief = (overrides: Partial<Brief> = {}): Brief => ({
  headline: 'Acme is modernising after a Series A',
  claims: [
    { claim: 'Raised a Series A in September', signal_id: 'sig_1' },
    { claim: 'Hiring three backend engineers', signal_id: 'sig_2' },
  ],
  suggested_opening_line: 'Saw the Series A — congratulations.',
  opening_line_signal_ids: ['sig_1'],
  risks: [],
  confidence: 'medium',
  ...overrides,
});

/**
 * Acceptance A7: "No brief contains a claim without a valid `signalId`."
 * FR-AI6 says this is enforced in code, not requested in the prompt — so it
 * is tested here as code.
 */
describe('validateBrief (FR-AI6, FR-AI7)', () => {
  it('accepts a brief whose every claim cites a real signal', () => {
    expect(validateBrief(brief(), KNOWN)).toEqual({ valid: true, defects: [] });
  });

  it('rejects a fabricated signal id', () => {
    const result = validateBrief(
      brief({
        claims: [{ claim: 'Migrating off Oracle', signal_id: 'sig_does_not_exist' }],
      }),
      KNOWN,
    );
    expect(result.valid).toBe(false);
    expect(result.defects[0].kind).toBe('unknown-signal-id');
    expect(result.defects[0].detail).toContain('sig_does_not_exist');
  });

  it('rejects a claim with an empty citation', () => {
    const result = validateBrief(
      brief({ claims: [{ claim: 'They need a rewrite', signal_id: '   ' }] }),
      KNOWN,
    );
    expect(result.valid).toBe(false);
    expect(result.defects[0].kind).toBe('uncited-claim');
  });

  it('names which claim is at fault, so the defect is actionable', () => {
    const result = validateBrief(
      brief({
        claims: [
          { claim: 'Raised a Series A', signal_id: 'sig_1' },
          { claim: 'Revenue is $40M', signal_id: 'invented' },
        ],
      }),
      KNOWN,
    );
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0].detail).toContain('claims[1]');
  });

  // FR-AI7 — the opening line is the part a human actually sends.
  it('rejects an opening line citing a signal that does not exist', () => {
    const result = validateBrief(brief({ opening_line_signal_ids: ['ghost'] }), KNOWN);
    expect(result.valid).toBe(false);
    expect(result.defects.some((d) => d.detail.includes('suggested_opening_line'))).toBe(true);
  });

  it('rejects an opening line citing nothing at all', () => {
    const result = validateBrief(brief({ opening_line_signal_ids: [] }), KNOWN);
    expect(result.valid).toBe(false);
    expect(result.defects[0].kind).toBe('uncited-opening-line');
  });

  it('reports every defect at once rather than only the first', () => {
    const result = validateBrief(
      brief({
        claims: [
          { claim: 'a', signal_id: 'nope1' },
          { claim: 'b', signal_id: '' },
        ],
        opening_line_signal_ids: ['nope2'],
      }),
      KNOWN,
    );
    expect(result.defects).toHaveLength(3);
  });

  it('rejects everything when the company has no signals', () => {
    expect(validateBrief(brief(), new Set()).valid).toBe(false);
  });
});

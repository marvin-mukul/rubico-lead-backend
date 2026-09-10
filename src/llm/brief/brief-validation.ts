import type { Brief } from '../schemas.js';

export interface BriefDefect {
  kind: 'uncited-claim' | 'unknown-signal-id' | 'uncited-opening-line';
  detail: string;
}

export interface BriefValidation {
  valid: boolean;
  defects: BriefDefect[];
}

/**
 * FR-AI6: "every claim in a generated brief must carry a `signalId` that
 * exists in the database. A brief with an uncited claim is rejected and
 * logged as a defect, not surfaced to a human. This is enforced in code, not
 * requested in the prompt."
 *
 * FR-AI7: the suggested opening line references only cited evidence.
 *
 * Pure function over the model output and the set of ids that genuinely
 * exist for this company — the caller supplies the latter from the database,
 * so a hallucinated id cannot pass by looking well-formed.
 */
export function validateBrief(brief: Brief, knownSignalIds: Set<string>): BriefValidation {
  const defects: BriefDefect[] = [];

  for (const [index, claim] of brief.claims.entries()) {
    const id = claim.signal_id?.trim();
    if (!id) {
      defects.push({
        kind: 'uncited-claim',
        detail: `claims[${index}] has no signal_id: "${truncate(claim.claim)}"`,
      });
      continue;
    }
    if (!knownSignalIds.has(id)) {
      defects.push({
        kind: 'unknown-signal-id',
        detail: `claims[${index}] cites "${id}", which is not a signal for this company`,
      });
    }
  }

  // FR-AI7 — an opening line the recipient cannot recognise as true is worse
  // than no opening line at all.
  const openingIds = brief.opening_line_signal_ids ?? [];
  if (openingIds.length === 0) {
    defects.push({
      kind: 'uncited-opening-line',
      detail: 'suggested_opening_line cites no signals',
    });
  }
  for (const id of openingIds) {
    if (!knownSignalIds.has(id)) {
      defects.push({
        kind: 'unknown-signal-id',
        detail: `suggested_opening_line cites "${id}", which is not a signal for this company`,
      });
    }
  }

  return { valid: defects.length === 0, defects };
}

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

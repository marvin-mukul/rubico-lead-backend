import type { Classification } from '../schemas.js';

export interface ClassifyDefect {
  kind: 'unknown-signal-id';
  detail: string;
}

export interface ClassifyValidation {
  valid: boolean;
  defects: ClassifyDefect[];
}

/**
 * P22: extends FR-AI6's citation enforcement to the why-this-lead chain
 * (§2.5.7) — the same rule as `validateBrief`, applied one step earlier.
 * `cited_signal_ids` and every `why_this_lead[].signal_ids` entry must name a
 * signal that genuinely exists for this company; a hallucinated id is a
 * defect, discarded before scoring rather than repaired.
 */
export function validateClassification(
  classification: Classification,
  knownSignalIds: Set<string>,
): ClassifyValidation {
  const defects: ClassifyDefect[] = [];

  const check = (ids: string[], where: string): void => {
    for (const id of ids) {
      if (!knownSignalIds.has(id)) {
        defects.push({
          kind: 'unknown-signal-id',
          detail: `${where} cites "${id}", which is not a signal for this company`,
        });
      }
    }
  };

  check(classification.cited_signal_ids, 'cited_signal_ids');
  classification.why_this_lead.forEach((step, index) =>
    check(step.signal_ids, `why_this_lead[${index}]`),
  );

  return { valid: defects.length === 0, defects };
}

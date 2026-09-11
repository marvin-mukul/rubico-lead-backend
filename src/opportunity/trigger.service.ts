import { Injectable } from '@nestjs/common';
import { isEventSignal } from '../common/domain/index.js';
import { OpportunityConfigService } from './opportunity-config.service.js';
import type { ArchetypeKey } from './opportunity-config.schemas.js';

/** The minimum a signal must expose for the gate to read it. */
export interface TriggerableSignal {
  id: string;
  type: string;
  /** Human-readable summary — the primary text the patterns run against. */
  excerpt?: string | null;
  /** The semantic subject, e.g. `hiring Senior Engineer`. */
  subject?: string | null;
}

export interface TriggerMatch {
  signalId: string;
  family: string;
  /** The literal text that matched, so a decision is inspectable. */
  matched: string;
}

export interface TriggerVerdict {
  /** False means the company never reaches a billable call. */
  passed: boolean;
  families: string[];
  /** Candidate archetypes. A suggestion for the classifier, not a decision. */
  archetypes: ArchetypeKey[];
  matches: TriggerMatch[];
}

/**
 * The zero-cost gate between signal persistence and the first billable call
 * (§2.2). This is the constraint the broadening had to preserve: industry
 * stopped being a hard filter, so *something* deterministic and free has to
 * stand here or cost scales with the funnel.
 *
 * It replaces the fit filter in that role, deliberately. The fit filter asks
 * "is this the right kind of company?", which §2.5.4 says must not be a hard
 * exclusion — and no reweighting turns that question into the right one. The
 * trigger asks "is there evidence of a technology problem?", which is what
 * §2.5.1–3 actually care about. The fit score still contributes to
 * `totalScore`; it just no longer decides who gets paid for.
 *
 * **Tuned for recall, by decision.** Any single family match admits the
 * company. A false negative silently drops a real opportunity and is
 * unrecoverable — nothing downstream can rescue a signal the gate discarded.
 * A false positive costs one classify call, about $0.0002, and the classifier
 * is already required to refuse cheaply (FR-AI5). Precision belongs there.
 *
 * **Only event signals can satisfy the gate.** `F-LEG` and `F-PLAT` are
 * standing properties: running WordPress tells you what a company has, not
 * that it needs anything (§2.5.5). They are still reported as context when
 * they match a family, but they cannot open the gate on their own.
 */
@Injectable()
export class OpportunityTriggerService {
  constructor(private readonly config: OpportunityConfigService) {}

  evaluate(signals: TriggerableSignal[]): TriggerVerdict {
    const matches: TriggerMatch[] = [];
    const families = new Set<string>();
    const archetypes = new Set<ArchetypeKey>();
    let openedByEvent = false;

    const preQualified = new Set(this.config.triggers.preQualifiedSignalTypes);

    for (const signal of signals) {
      // Relevance already established upstream — see preQualifiedSignalTypes.
      // A CPV-72 tender is technology work by the code it was filed under;
      // demanding its title also match a phrase list only loses real leads.
      if (preQualified.has(signal.type) && isEventSignal(signal.type)) {
        openedByEvent = true;
      }

      const text = textOf(signal);
      if (!text) continue;

      for (const family of this.config.triggerFamilies) {
        const hit = firstMatch(family.patterns, text);
        if (!hit) continue;

        matches.push({ signalId: signal.id, family: family.key, matched: hit });
        families.add(family.key);
        for (const archetype of family.archetypes) archetypes.add(archetype);

        if (isEventSignal(signal.type)) openedByEvent = true;
      }
    }

    return {
      passed: openedByEvent,
      families: [...families].sort(),
      archetypes: [...archetypes].sort(),
      matches,
    };
  }
}

/**
 * Subject is included, not just excerpt. An ATS signal's excerpt is
 * "Senior Software Engineer — Seattle" while its subject is "hiring Senior
 * Software Engineer", and the hiring family keys off the verb.
 */
function textOf(signal: TriggerableSignal): string {
  return [signal.subject, signal.excerpt].filter(Boolean).join(' ').trim();
}

function firstMatch(patterns: RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) return found[0];
  }
  return undefined;
}

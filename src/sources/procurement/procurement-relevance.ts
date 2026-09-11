import type { ProcurementNotice } from './procurement-provider.interface.js';

/**
 * Is this notice about technology work Rubico could do?
 *
 * A deterministic, zero-cost filter run at the source, before anything is
 * persisted or classified. Public procurement is mostly construction,
 * catering, refurbishment and vehicles; without this the engine would ingest
 * every roof repair in the country.
 *
 * Two independent tests, either sufficient:
 *
 *   1. A technology CPV/PSC code — high precision, no text involved.
 *   2. A technology phrase in the title or description — needed for recall,
 *      because classification codes are often generic. In a live sample only
 *      0 of 27 notices carried a CPV under 72/48 while roughly 6% were
 *      plainly technology work by their title.
 *
 * Tuned for recall over precision per §2.2: a false negative silently drops a
 * real opportunity and is unrecoverable, while a false positive costs one
 * classify call (~$0.0002). The classifier is required to be able to say no
 * cheaply (FR-AI5); this filter exists to control volume, not to qualify.
 */

/**
 * CPV divisions (EU/UK): 72 = IT services, 48 = software packages.
 * PSC (US): D = IT & telecom services, 70 = IT equipment/software.
 */
const CODE_PATTERNS: RegExp[] = [/^72/, /^48/, /^D3?\d/i, /^70/];

/**
 * Phrases specific enough not to match "heating system" or "drainage works".
 * Bare words like `system`, `platform` and `digital` are deliberately absent —
 * they match a huge amount of civil engineering.
 */
const PHRASES: RegExp[] = [
  /\bsoftware\b/i,
  /\bweb\s?site\b|\bwebsite\b|\bweb development\b|\bweb portal\b/i,
  /\bintranet\b|\bextranet\b/i,
  /\bdigital transformation\b|\bdigitali[sz]ation\b|\bdigitisation\b/i,
  /\bdigital (?:platform|services|solution|strategy)\b/i,
  /\bmobile (?:app|application)\b|\bios app\b|\bandroid app\b/i,
  /\be-?commerce\b|\bonline (?:shop|store|ordering|booking|payment)s?\b/i,
  /\bcrm\b|\berp\b|\bcms\b|\blms\b|\bmis\b/i,
  /\bmanagement information system\b/i,
  /\bcase management system\b|\bbooking system\b|\bpayment system\b/i,
  /\bdatabase\b|\bdata (?:migration|warehouse|platform)\b/i,
  /\bapi\b|\bsystems? integration\b|\bintegration platform\b/i,
  /\bit services\b|\bmanaged it\b|\bit support\b|\bit infrastructure\b|\bict\b/i,
  /\bcloud (?:migration|hosting|services)\b|\bsaas\b/i,
  /\bapplication (?:development|support|modernisation|modernization)\b/i,
  /\blearning platform\b|\bcustomer portal\b|\bself-?service portal\b/i,
];

export interface RelevanceVerdict {
  relevant: boolean;
  /** Why it matched, so a signal can carry its own justification. */
  reason?: string;
}

export function assessRelevance(notice: ProcurementNotice): RelevanceVerdict {
  const code = (notice.classification ?? '').trim();
  if (code && CODE_PATTERNS.some((pattern) => pattern.test(code))) {
    return { relevant: true, reason: `classification ${code}` };
  }

  const text = `${notice.title} ${notice.description ?? ''}`;
  for (const phrase of PHRASES) {
    const match = phrase.exec(text);
    if (match) return { relevant: true, reason: `matched "${match[0]}"` };
  }

  return { relevant: false };
}

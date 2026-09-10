import type { CompanyModel as Company } from '../generated/prisma/models.js';

export interface ResolvedContact {
  name: string;
  role?: string;
  seniority?: string;
  email?: string;
  emailStatus?: string;
  /** Provider name, or 'manual'. Stored on Contact.source. */
  source: string;
  /** Credits or dollars consumed. Always 0 for free/manual resolution. */
  creditCost: number;
}

/**
 * Seam 4 of the eight (§4).
 *
 * Phase 0 has exactly one implementation and it is manual — §14 puts paid
 * contact resolvers out of scope. The interface exists now so that a Phase 1
 * paid resolver is a new class plus a config line, and so FR-C5 has a single
 * place to guard.
 */
export interface ContactResolver {
  readonly name: string;
  readonly cost: 'free' | 'metered';
  resolve(company: Company, role: string[]): Promise<ResolvedContact[]>;
}

export const CONTACT_RESOLVER = Symbol('CONTACT_RESOLVER');

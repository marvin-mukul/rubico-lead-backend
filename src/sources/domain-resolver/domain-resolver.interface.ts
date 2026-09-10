/**
 * Company name → web domain.
 *
 * NOT one of the eight seams in §4 — it exists because of a gap the spec did
 * not anticipate. `Company.canonicalDomain` is the required unique identity
 * key, but SEC Form D carries no website: the filing XML has no URL at all,
 * and `data.sec.gov/submissions` returns an empty `website` for essentially
 * every Form D filer. Without a name→domain step, `ingest.sec-edgar` can
 * produce signals it can never attach to a company.
 *
 * Selected by `SEC_DOMAIN_RESOLVER`, defaulting to `none`. See the two
 * implementations for the trade-off; the choice is the operator's, because
 * fuzzy name matching can attach a *wrong* domain, and a wrong domain is
 * worse than a missing one — it merges two companies under one identity.
 */
export interface DomainResolver {
  readonly name: string;
  /** Null when no confident match exists. Never guess. */
  resolve(companyName: string): Promise<string | null>;
}

export const DOMAIN_RESOLVER = Symbol('DOMAIN_RESOLVER');

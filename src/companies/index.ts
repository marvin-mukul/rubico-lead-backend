export { CompaniesModule } from './companies.module.js';
export { CompanyRepository } from './company.repository.js';
export { SuppressionService } from './suppression.service.js';
export { FitFilterService, slugify } from './fit-filter.service.js';
export {
  resolveCanonicalDomain,
  canonicalDomain,
  KNOWN_FREE_MAIL_DOMAINS,
  KNOWN_AGGREGATOR_DOMAINS,
} from './canonical-domain.js';
export type { CompanyUpsert } from './company.repository.js';
export type { FitInput, FitResult, FitContribution } from './fit-filter.service.js';
export type { CanonicalDomainResult, RejectionReason } from './canonical-domain.js';

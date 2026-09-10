import { Injectable } from '@nestjs/common';
import type { DomainResolver } from './domain-resolver.interface.js';

/**
 * The default. Resolves nothing, so a filing with no website of its own is
 * counted as `filteredOut` and never becomes a company.
 *
 * This is the conservative choice and it is deliberately the default:
 * attaching a guessed domain to a company silently merges two real companies
 * under one identity, and every downstream stage — dedupe, scoring, the brief
 * a human reads — then inherits that error with no way to notice it.
 *
 * The cost is that `ingest.sec-edgar` contributes few or no companies on its
 * own. Set `SEC_DOMAIN_RESOLVER=clearbit` to trade that for fuzzy matching.
 */
@Injectable()
export class NullDomainResolver implements DomainResolver {
  readonly name = 'none';

  async resolve(): Promise<string | null> {
    return null;
  }
}

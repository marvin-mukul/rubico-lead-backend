import { Injectable } from '@nestjs/common';
import type { ContactResolver, ResolvedContact } from './contact-resolver.interface.js';

/**
 * The only Phase 0 resolver: contacts are entered by a human, so there is
 * nothing to look up and nothing to bill. It exists as a class rather than a
 * special case so `POST /api/contacts` goes through the same seam, and the
 * same FR-C5 assertion, that a paid resolver will.
 */
@Injectable()
export class ManualContactResolver implements ContactResolver {
  readonly name = 'manual';
  readonly cost = 'free' as const;

  async resolve(): Promise<ResolvedContact[]> {
    // Nothing to resolve — a human supplies the contact directly.
    return [];
  }
}

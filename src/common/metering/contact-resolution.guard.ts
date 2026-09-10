import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ContactResolutionPolicy } from './contact-resolution.policy.js';

/** Reads `leadId` from the route params, query string, or body. */
function extractLeadId(request: Request): string | undefined {
  const fromParams = (request.params as Record<string, string> | undefined)?.leadId;
  const fromQuery = (request.query as Record<string, unknown> | undefined)?.leadId;
  const fromBody = (request.body as Record<string, unknown> | undefined)?.leadId;
  const candidate = fromParams ?? fromQuery ?? fromBody;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Route-level half of FR-C5. The service-level assertion in
 * ContactResolutionPolicy is the authoritative one; this simply rejects before
 * any work starts.
 */
@Injectable()
export class ContactResolutionGuard implements CanActivate {
  constructor(private readonly policy: ContactResolutionPolicy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const leadId = extractLeadId(context.switchToHttp().getRequest<Request>());
    if (!leadId) {
      throw new BadRequestException('leadId is required for contact resolution (FR-C5)');
    }
    await this.policy.assertLeadApproved(leadId);
    return true;
  }
}

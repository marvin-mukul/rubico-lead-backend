import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { LeadStatus } from '../domain/index.js';
import { PrismaService } from '../prisma/index.js';

/**
 * FR-C5: contact resolution is unreachable for a lead that is not approved.
 *
 * §6.2 requires this "enforced by a Nest guard on the route *and* an assertion
 * inside the service, because the service will later be called from a job as
 * well as a route". This class is the single implementation both use — the
 * guard is not a duplicate rule, it is an early rejection of the same rule.
 */
@Injectable()
export class ContactResolutionPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async assertLeadApproved(leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { status: true },
    });

    if (!lead) {
      throw new NotFoundException(`Lead ${leadId} not found`);
    }
    if ((lead.status as LeadStatus) !== 'approved') {
      throw new ForbiddenException(
        `Contact resolution requires lead.status === "approved"; lead ${leadId} is "${lead.status}" (FR-C5)`,
      );
    }
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ContactResolutionPolicy } from '../common/metering/index.js';
import { PrismaService } from '../common/prisma/index.js';
import type { CreateContactBody } from '../api/dto.js';

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ContactResolutionPolicy,
  ) {}

  async listForLead(leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { companyId: true },
    });
    if (!lead) throw new NotFoundException(`Lead ${leadId} not found`);

    const contacts = await this.prisma.contact.findMany({
      where: { companyId: lead.companyId },
      orderBy: { resolvedAt: 'desc' },
    });
    return { contacts: contacts.map(serialise) };
  }

  /**
   * FR-C5, the service-level half: "enforced by a Nest guard on the route
   * *and* an assertion inside the service, because the service will later be
   * called from a job as well as a route."
   *
   * The guard rejects earlier; this assertion is the one that actually holds,
   * because a job calling this method bypasses the guard entirely.
   */
  async create(body: CreateContactBody) {
    await this.policy.assertLeadApproved(body.leadId);

    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: body.leadId },
      select: { companyId: true },
    });

    const contact = await this.prisma.contact.create({
      data: {
        companyId: lead.companyId,
        name: body.name,
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(body.seniority === undefined ? {} : { seniority: body.seniority }),
        ...(body.email === undefined ? {} : { email: body.email }),
        source: 'manual',
        creditCost: 0,
      },
    });

    this.logger.log(`Manual contact added for lead ${body.leadId}`);
    return serialise(contact);
  }
}

function serialise(contact: {
  id: string;
  companyId: string;
  name: string;
  role: string | null;
  seniority: string | null;
  email: string | null;
  emailStatus: string | null;
  source: string;
  creditCost: number;
  resolvedAt: Date;
}) {
  return { ...contact, resolvedAt: contact.resolvedAt.toISOString() };
}

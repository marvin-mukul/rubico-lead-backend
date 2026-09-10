import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { CompanyModel as Company } from '../generated/prisma/models.js';
import { PrismaService } from '../common/prisma/index.js';

export interface CompanyUpsert {
  canonicalDomain: string;
  name: string;
  country?: string | null;
  region?: string | null;
  headcountBand?: string | null;
  industry?: string | null;
  atsProvider?: string | null;
  atsSlug?: string | null;
}

/** Only overwrite a stored value when we actually have a new one. */
function definedOnly<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  ) as Partial<T>;
}

@Injectable()
export class CompanyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dedupe by canonical domain. The `@unique` constraint on the column is the
   * mechanism; this upsert is how ingestion uses it (acceptance A2 — re-running
   * a job creates zero duplicate rows).
   */
  async upsertByDomain(input: CompanyUpsert): Promise<Company> {
    const { canonicalDomain, name, ...rest } = input;
    const updatable = definedOnly(rest);

    return this.prisma.company.upsert({
      where: { canonicalDomain },
      create: { canonicalDomain, name, ...updatable },
      // Never blank out a field we already know just because this source
      // did not supply it.
      update: updatable,
    });
  }

  findByDomain(canonicalDomain: string): Promise<Company | null> {
    return this.prisma.company.findUnique({ where: { canonicalDomain } });
  }

  findById(id: string): Promise<Company | null> {
    return this.prisma.company.findUnique({ where: { id } });
  }

  async markEnriched(
    id: string,
    data: { detectedStack?: Prisma.InputJsonValue; legacyFlags?: Prisma.InputJsonValue },
  ): Promise<void> {
    await this.prisma.company.update({
      where: { id },
      data: { ...data, lastEnrichedAt: new Date() },
    });
  }
}

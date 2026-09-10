import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import { CompanyRepository, resolveCanonicalDomain } from '../companies/index.js';
import type { JobContext } from '../jobs/index.js';
import { SignalRepository, type RawSignal } from '../signals/index.js';

/**
 * Turns what a source emitted into companies and signals.
 *
 * Shared by every source so the rules — canonical domain, suppression,
 * dedupe, counting — exist once. A source that wanted to bend any of them
 * would be doing business logic, which is not a source's job (§1).
 *
 * FR-B9: per record, not per batch. One malformed record is counted and
 * skipped; everything committed before it stays committed.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly companies: CompanyRepository,
    private readonly signals: SignalRepository,
    private readonly prisma: PrismaService,
  ) {}

  async ingest(raw: RawSignal[], context: JobContext): Promise<void> {
    for (const signal of raw) {
      context.count('fetched');
      try {
        await this.ingestOne(signal, context);
      } catch (error) {
        // A single bad record must not end the run (FR-B9).
        context.count('failed');
        this.logger.warn(
          `Skipped a ${signal.sourceName} record for "${signal.companyName}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async ingestOne(signal: RawSignal, context: JobContext): Promise<void> {
    const { domain, reason } = resolveCanonicalDomain(signal.domain);
    if (!domain) {
      // No identity, no company. Counted rather than thrown: an unresolvable
      // domain is an expected outcome, not a failure of the run.
      context.count('filteredOut');
      this.logger.debug(`No canonical domain for "${signal.companyName}" (${reason})`);
      return;
    }

    if (context.dryRun) return;

    const company = await this.companies.upsertByDomain({
      canonicalDomain: domain,
      name: signal.companyName,
    });

    if (company.suppressionReason) {
      context.count('suppressed');
      return;
    }

    const outcome = await this.signals.insert({
      companyId: company.id,
      type: signal.type,
      eventDate: signal.eventDate,
      sourceUrl: signal.sourceUrl,
      sourceName: signal.sourceName,
      subject: signal.subject,
      ...(signal.excerpt === undefined ? {} : { excerpt: signal.excerpt }),
      raw: signal.raw as never,
    });

    if (!outcome.created) context.count('deduped');
  }

  /** Companies with at least one signal — used by acceptance check A1. */
  async companiesWithSignals(sourceName?: string): Promise<number> {
    const rows = await this.prisma.signal.findMany({
      where: sourceName ? { sourceName } : {},
      distinct: ['companyId'],
      select: { companyId: true },
    });
    return rows.length;
  }
}

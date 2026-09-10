import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SignalType } from '../../common/domain/index.js';
import { PrismaService } from '../../common/prisma/index.js';
import { SuppressionService } from '../../companies/index.js';
import type { RawSignal } from '../../signals/index.js';
import type { SignalSource } from '../signal-source.interface.js';
import { ATS_PROVIDER, type AtsProvider } from './ats-provider.interface.js';

/**
 * ATS boards — Greenhouse, Lever, Ashby (§7.2, signal type S2: hiring).
 *
 * Iterates **tracked companies only** — those with an `atsProvider` and
 * `atsSlug` already on the row — rather than the whole table. Discovery of
 * which board a company uses is a different problem, handled when a company
 * is first seen.
 */
@Injectable()
export class AtsSource implements SignalSource {
  readonly name = 'ats';
  readonly signalTypes: SignalType[] = ['S2'];

  private readonly logger = new Logger(AtsSource.name);
  private readonly byName: Map<string, AtsProvider>;

  constructor(
    @Inject(ATS_PROVIDER) providers: AtsProvider[],
    private readonly prisma: PrismaService,
  ) {
    this.byName = new Map(providers.map((provider) => [provider.name, provider]));
  }

  async fetch(since: Date): Promise<RawSignal[]> {
    const tracked = await this.prisma.company.findMany({
      where: {
        atsProvider: { not: null },
        atsSlug: { not: null },
        ...SuppressionService.activeFilter(),
      },
      select: { canonicalDomain: true, name: true, atsProvider: true, atsSlug: true },
    });

    this.logger.log(`Checking ${tracked.length} tracked board(s) since ${since.toISOString()}`);

    const signals: RawSignal[] = [];
    for (const company of tracked) {
      const provider = this.byName.get(company.atsProvider ?? '');
      if (!provider) {
        this.logger.warn(`Unknown ATS provider "${company.atsProvider}" for ${company.canonicalDomain}`);
        continue;
      }

      let postings;
      try {
        postings = await provider.listPostings(company.atsSlug ?? '');
      } catch (error) {
        // One unreachable board must not end the run for every other company.
        this.logger.warn(
          `${provider.name}/${company.atsSlug} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      if (postings === null) {
        this.logger.warn(
          `${provider.name} board "${company.atsSlug}" not found for ${company.canonicalDomain}`,
        );
        continue;
      }

      for (const posting of postings) {
        if (posting.postedAt < since) continue;
        signals.push({
          domain: company.canonicalDomain,
          companyName: company.name,
          type: 'S2',
          eventDate: posting.postedAt,
          sourceUrl: posting.url,
          sourceName: `ats:${provider.name}`,
          excerpt: [posting.title, posting.location].filter(Boolean).join(' — '),
          // Per role, per day: a board that re-lists the same job daily
          // produces one signal per day, not one per poll.
          subject: `hiring ${posting.title}`,
          raw: { provider: provider.name, slug: company.atsSlug, posting },
        });
      }
    }

    return signals;
  }
}

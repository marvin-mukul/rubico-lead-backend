import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { SignalType } from '../../common/domain/index.js';
import type { RawSignal } from '../../signals/index.js';
import type { SignalSource } from '../signal-source.interface.js';
import {
  PROCUREMENT_PROVIDER,
  type ProcurementNotice,
  type ProcurementProvider,
} from './procurement-provider.interface.js';
import { assessRelevance } from './procurement-relevance.js';

/**
 * Public procurement — UK Contracts Finder, TED (EU) and SAM.gov (US),
 * emitting signal type **S6**.
 *
 * This is the strongest evidence class the engine has. A tender is an
 * organisation stating, in public and with a budget and a deadline, that it
 * intends to buy something. Everything else the engine ingests is inferred:
 * a job posting implies a project, a Hacker News post implies a problem. A
 * tender declares one.
 *
 * It is also the breadth fix. The other sources reach software companies
 * because that is who posts to Hacker News and runs a Greenhouse board.
 * Procurement reaches schools, councils, universities, NHS trusts and
 * charities — which is what Rubico's published client list actually looks
 * like.
 */
@Injectable()
export class ProcurementSource implements SignalSource {
  readonly name = 'procurement';
  readonly signalTypes: SignalType[] = ['S6'];

  private readonly logger = new Logger(ProcurementSource.name);

  constructor(
    @Inject(PROCUREMENT_PROVIDER) private readonly providers: ProcurementProvider[],
    private readonly config: AppConfigService,
  ) {}

  async fetch(since: Date): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];

    // Which feeds run is configuration, not code (§2.3). `ted-eu` is off by
    // default — see PROCUREMENT_FEEDS for why a working source is switched
    // off on purpose.
    const enabled = new Set(this.config.procurementFeeds);
    const active = this.providers.filter((provider) => enabled.has(provider.name));

    const skipped = this.providers
      .filter((provider) => !enabled.has(provider.name))
      .map((provider) => provider.name);
    if (skipped.length > 0) {
      // Logged rather than silent: a feed that is off must be visibly off,
      // or its absence gets diagnosed as a bug months later.
      this.logger.log(`Feeds disabled by PROCUREMENT_FEEDS: ${skipped.join(', ')}`);
    }

    for (const provider of active) {
      // Providers swallow their own failures and return []; one dead portal
      // must not cost the run the other two.
      const notices = await provider.fetchSince(since);
      let relevant = 0;
      let withoutContact = 0;

      for (const notice of notices) {
        const verdict = assessRelevance(notice);
        if (!verdict.relevant) continue;
        relevant++;

        // No contact email means no domain, and a tender we cannot attribute
        // to a company is the `sec-edgar` failure all over again. Counted and
        // dropped here rather than becoming an unattributable signal.
        if (!notice.buyerEmail) {
          withoutContact++;
          continue;
        }

        signals.push(this.toSignal(provider, notice, verdict.reason));
      }

      this.logger.log(
        `${provider.name}: ${notices.length} notice(s), ${relevant} technology-related, ` +
          `${withoutContact} without a contact email`,
      );
    }

    return signals;
  }

  private toSignal(
    provider: ProcurementProvider,
    notice: ProcurementNotice,
    reason: string | undefined,
  ): RawSignal {
    const value =
      notice.valueAmount === undefined
        ? ''
        : ` (${notice.valueCurrency ?? ''} ${Math.round(notice.valueAmount).toLocaleString()})`;

    return {
      // The contact email carries the domain — exact attribution, no
      // name→domain resolution anywhere in this path.
      domain: notice.buyerEmail ?? '',
      companyName: notice.buyerName,
      type: 'S6',
      eventDate: notice.publishedAt,
      sourceUrl: notice.noticeUrl,
      sourceName: `procurement:${provider.name}`,
      excerpt: `${notice.title}${value}`,
      // Per buyer, per day, per tender title: re-running the job produces the
      // same subject and dedupes, while a genuinely new tender does not.
      subject: `procurement ${notice.title}`,
      raw: { ...notice, provider: provider.name, relevance: reason ?? null },
    };
  }
}

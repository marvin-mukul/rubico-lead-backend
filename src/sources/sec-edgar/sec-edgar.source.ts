import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import type { SignalType } from '../../common/domain/index.js';
import type { RawSignal } from '../../signals/index.js';
import { DOMAIN_RESOLVER, type DomainResolver } from '../domain-resolver/domain-resolver.interface.js';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { SignalSource } from '../signal-source.interface.js';

/**
 * SEC EDGAR — Form D filings (§7.2, signal type S1: funding).
 *
 * Reads the daily form index rather than the `getcurrent` feed: `getcurrent`
 * only covers the last few hours and its `type=` filter is a *prefix* match
 * (`type=D` also returns DEF 14A and DEFA14A). The daily index is complete
 * for a date and lets a watermark resume precisely.
 *
 * FR-B21: every request carries SEC_USER_AGENT. SEC fair-access blocks
 * traffic without one that identifies the caller with a contact address.
 */

/** SEC asks for no more than ~10 requests/second. */
const SEC_MIN_INTERVAL_MS = 120;
/** Bound the work when a watermark is stale — a run must stay predictable. */
const MAX_DAYS_PER_RUN = 10;

const FORM_D_TYPES = new Set(['D', 'D/A']);

export interface IndexRow {
  formType: string;
  companyName: string;
  cik: string;
  dateFiled: string;
  fileName: string;
}

@Injectable()
export class SecEdgarSource implements SignalSource {
  readonly name = 'sec-edgar';
  readonly signalTypes: SignalType[] = ['S1'];

  private readonly logger = new Logger(SecEdgarSource.name);

  constructor(
    private readonly http: SourceHttpClient,
    private readonly config: AppConfigService,
    @Inject(DOMAIN_RESOLVER) private readonly domains: DomainResolver,
  ) {}

  async fetch(since: Date): Promise<RawSignal[]> {
    const days = datesBetween(since, new Date(), MAX_DAYS_PER_RUN);
    const signals: RawSignal[] = [];
    let missingDays = 0;

    for (const day of days) {
      const rows = await this.fetchDay(day);
      if (rows === null) {
        missingDays++;
        continue;
      }
      for (const row of rows) {
        signals.push(await this.toSignal(row));
      }
    }

    // A weekend or federal holiday has no index, and SEC answers 403 for it —
    // the same status it uses to block a client. Those are indistinguishable
    // per request, so treat "every single day was missing" as a block rather
    // than reporting a quiet, successful zero. A run that silently ingests
    // nothing forever is the failure mode worth preventing here.
    if (days.length > 0 && missingDays === days.length) {
      throw new Error(
        `SEC returned no index for any of ${days.length} day(s) from ${isoDay(days[0])}. ` +
          'That is expected only across a weekend or holiday; otherwise SEC is blocking this ' +
          'client. Check SEC_USER_AGENT identifies Rubico with a contact address (FR-B21).',
      );
    }

    return signals;
  }

  /** Null when SEC has no index for that day. Exposed for tests. */
  async fetchDay(day: Date): Promise<IndexRow[] | null> {
    const url = dailyIndexUrl(day);
    // Weekends and federal holidays simply have no index file.
    const body = await this.http.getText({
      url,
      minIntervalMs: SEC_MIN_INTERVAL_MS,
      acceptMissing: true,
      // SEC uses 403 for "this date has no index file" as well as for a
      // blocked client; fetch() cannot tell them apart per request.
      treatAsMissing: [403],
      headers: { 'user-agent': this.config.secUserAgent },
    });

    if (body === null) {
      this.logger.debug(`No daily index for ${isoDay(day)} (weekend, holiday, or blocked)`);
      return null;
    }
    return parseFormIndex(body).filter((row) => FORM_D_TYPES.has(row.formType));
  }

  private async toSignal(row: IndexRow): Promise<RawSignal> {
    // SEC carries no website for a filer, so this is the only place a domain
    // can come from. With the default resolver it is always null, and
    // IngestionService counts the record as filteredOut.
    const domain = (await this.domains.resolve(row.companyName)) ?? '';

    return {
      domain,
      companyName: row.companyName,
      type: 'S1',
      eventDate: parseFiledDate(row.dateFiled),
      sourceUrl: filingUrl(row),
      sourceName: this.name,
      excerpt: `${row.formType} filed ${row.dateFiled} by ${row.companyName} (CIK ${row.cik})`,
      // Per company, per day, per form type: a re-run produces the same
      // subject and dedupes, while a later D/A is a genuinely new event.
      subject: `form-${row.formType.toLowerCase().replace('/', '-')}`,
      raw: { ...row, resolvedDomain: domain || null, resolver: this.domains.name },
    };
  }
}

/** `https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260909.idx` */
export function dailyIndexUrl(day: Date): string {
  const year = day.getUTCFullYear();
  const quarter = Math.floor(day.getUTCMonth() / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${year}/QTR${quarter}/form.${isoDay(day).replace(/-/g, '')}.idx`;
}

export function filingUrl(row: IndexRow): string {
  // edgar/data/2153967/0002153967-26-000001.txt → the human-readable index.
  const match = /edgar\/data\/(\d+)\/([\d-]+)\.txt$/.exec(row.fileName);
  if (!match) return `https://www.sec.gov/Archives/${row.fileName}`;
  const [, cik, accession] = match;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}-index.htm`;
}

/**
 * The `.idx` form index is fixed-width, and company names contain spaces, so
 * it cannot be split on whitespace. Column offsets are taken from the header
 * separator line rather than hard-coded, because SEC has widened them before.
 */
export function parseFormIndex(body: string): IndexRow[] {
  const lines = body.split('\n');
  const headerIndex = lines.findIndex((line) => /^Form Type\s+Company Name/.test(line));
  if (headerIndex === -1) return [];

  const header = lines[headerIndex];
  const companyAt = header.indexOf('Company Name');
  const cikAt = header.indexOf('CIK');

  const rows: IndexRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || /^-+$/.test(line.trim())) continue;

    const formType = line.slice(0, companyAt).trim();
    const companyName = line.slice(companyAt, cikAt).trim();
    // CIK, date and filename are whitespace-separated and none contain spaces.
    const tail = line.slice(cikAt).trim().split(/\s+/);
    if (!formType || !companyName || tail.length < 3) continue;

    const [cik, dateFiled, fileName] = tail;
    rows.push({ formType, companyName, cik, dateFiled, fileName });
  }
  return rows;
}

function parseFiledDate(yyyymmdd: string): Date {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Inclusive UTC days from `since` to `until`, newest last, capped. */
export function datesBetween(since: Date, until: Date, maxDays: number): Date[] {
  const days: Date[] = [];
  const cursor = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  );
  const end = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());

  while (cursor.getTime() <= end && days.length < maxDays) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

import { Injectable, Logger } from '@nestjs/common';
import { SourceHttpClient } from '../http/source-http.client.js';
import type {
  ProcurementNotice,
  ProcurementProvider,
} from './procurement-provider.interface.js';

/**
 * The three public procurement feeds. All free, none needs a key.
 *
 * Every provider returns `[]` rather than throwing when its feed is
 * unavailable or its shape changes: one dead portal must not fail a run that
 * two others could still fill. A feed that is *consistently* dead shows up as
 * zero notices in the job counts, and after three failed runs the source
 * health check alerts (NFR-8).
 */

const dayStamp = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Pages per run, per provider. Bounds the work so a stale watermark cannot
 * turn one run into an afternoon, exactly as MAX_DAYS_PER_RUN does for SEC.
 */
const MAX_PAGES = 10;

// ── UK ────────────────────────────────────────────────────────────────────

interface OcdsRelease {
  ocid?: string;
  date?: string;
  buyer?: { name?: string };
  parties?: Array<{ contactPoint?: { email?: string } }>;
  tender?: {
    id?: string;
    title?: string;
    description?: string;
    classification?: { id?: string };
    value?: { amount?: number; currency?: string };
  };
}

interface OcdsSearchResponse {
  releases?: OcdsRelease[];
  links?: { next?: string };
}

/**
 * UK Contracts Finder, OCDS search API. Open Government Licence, no key.
 * Measured: 100 of 100 releases carried a contact email.
 */
@Injectable()
export class UkContractsFinderProvider implements ProcurementProvider {
  readonly name = 'uk-contracts-finder' as const;
  private readonly logger = new Logger(UkContractsFinderProvider.name);

  constructor(private readonly http: SourceHttpClient) {}

  async fetchSince(since: Date): Promise<ProcurementNotice[]> {
    let nextUrl: string | undefined =
      'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search' +
      `?stages=tender&publishedFrom=${dayStamp(since)}&limit=100`;

    const releases: OcdsRelease[] = [];
    try {
      // Cursor-paged via links.next. A 30-day window is several hundred
      // notices, and limit=100 would silently truncate it.
      for (let page = 0; page < MAX_PAGES; page++) {
        // Copied to a local before use: `nextUrl` is assigned from the
        // response below, and reading it directly in the request makes the
        // two types mutually dependent, which TypeScript cannot infer.
        const currentUrl: string | undefined = nextUrl;
        if (currentUrl === undefined) break;

        const body: OcdsSearchResponse | null = await this.http.getJson<OcdsSearchResponse>({
          url: currentUrl,
          minIntervalMs: 400,
        });
        const batch: OcdsRelease[] = body?.releases ?? [];
        releases.push(...batch);
        nextUrl = batch.length > 0 ? body?.links?.next : undefined;
      }

      return releases.flatMap((release) => {
        const title = release.tender?.title;
        const buyerName = release.buyer?.name;
        if (!title || !buyerName) return [];

        const email = release.parties
          ?.map((party) => party.contactPoint?.email)
          .find((value): value is string => Boolean(value));

        return [
          {
            id: release.ocid ?? release.tender?.id ?? title,
            buyerName,
            ...(email ? { buyerEmail: email } : {}),
            title,
            ...(release.tender?.description
              ? { description: release.tender.description }
              : {}),
            ...(release.tender?.classification?.id
              ? { classification: release.tender.classification.id }
              : {}),
            ...(release.tender?.value?.amount === undefined
              ? {}
              : { valueAmount: release.tender.value.amount }),
            ...(release.tender?.value?.currency
              ? { valueCurrency: release.tender.value.currency }
              : {}),
            publishedAt: release.date ? new Date(release.date) : new Date(),
            noticeUrl: `https://www.contractsfinder.service.gov.uk/Notice/${release.tender?.id ?? ''}`,
          } satisfies ProcurementNotice,
        ];
      });
    } catch (error) {
      this.logger.warn(`UK Contracts Finder unavailable: ${describe(error)}`);
      return [];
    }
  }
}

// ── EU ────────────────────────────────────────────────────────────────────

/** TED returns most text fields as `{ eng: [...], fra: [...] }`. */
type Multilingual = string | string[] | Record<string, string[] | string> | undefined;

export function pickLanguage(value: Multilingual): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;

  const record = value as Record<string, string[] | string>;
  // Prefer English, then any language present — a Czech hospital's name in
  // Czech is far better than no buyer at all.
  const preferred = record.eng ?? record.en ?? Object.values(record)[0];
  if (typeof preferred === 'string') return preferred;
  return Array.isArray(preferred) && typeof preferred[0] === 'string'
    ? preferred[0]
    : undefined;
}

interface TedNotice {
  'publication-number'?: string;
  'buyer-name'?: Multilingual;
  'buyer-email'?: Multilingual;
  'notice-title'?: Multilingual;
  'publication-date'?: string;
  'classification-cpv'?: Multilingual;
  links?: Record<string, unknown>;
}

/** TED (EU). CPV-filterable at the query, so relevance is decided upstream. */
@Injectable()
export class TedProvider implements ProcurementProvider {
  readonly name = 'ted-eu' as const;
  private readonly logger = new Logger(TedProvider.name);

  constructor(private readonly http: SourceHttpClient) {}

  async fetchSince(since: Date): Promise<ProcurementNotice[]> {
    // 72 = IT services, 48 = software packages. Filtering in the query keeps
    // the whole of EU construction procurement off the wire entirely.
    const query =
      'classification-cpv IN (72000000, 48000000) AND ' +
      `publication-date >= ${dayStamp(since).replace(/-/g, '')}`;

    const collected: TedNotice[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await this.http.postJson<{ notices?: TedNotice[] }>({
          url: 'https://api.ted.europa.eu/v3/notices/search',
          body: {
            query,
            limit: 100,
            page,
            fields: [
              'publication-number',
              'buyer-name',
              'buyer-email',
              'notice-title',
              'publication-date',
              'classification-cpv',
            ],
          },
          minIntervalMs: 500,
        });
        const batch = body?.notices ?? [];
        collected.push(...batch);
        if (batch.length < 100) break;
      }

      return collected.flatMap((notice) => {
        const title = pickLanguage(notice['notice-title']);
        const buyerName = pickLanguage(notice['buyer-name']);
        if (!title || !buyerName) return [];

        const email = pickLanguage(notice['buyer-email']);
        const number = notice['publication-number'] ?? title;
        const published = notice['publication-date'];

        return [
          {
            id: number,
            buyerName,
            ...(email ? { buyerEmail: email } : {}),
            title,
            // The query already constrained CPV, so record it as the reason.
            classification: pickLanguage(notice['classification-cpv']) ?? '72000000',
            // "2026-08-03+02:00" — trim the offset to a parseable date.
            publishedAt: published ? new Date(published.slice(0, 10)) : new Date(),
            noticeUrl: `https://ted.europa.eu/en/notice/-/detail/${number}`,
          } satisfies ProcurementNotice,
        ];
      });
    } catch (error) {
      this.logger.warn(`TED unavailable: ${describe(error)}`);
      return [];
    }
  }
}

// ── US ────────────────────────────────────────────────────────────────────

interface SamResult {
  _id?: string;
  title?: string;
  publishDate?: string;
  descriptions?: Array<{ content?: string }>;
  psc?: Array<{ code?: string | null }>;
  pointOfContacts?: Array<{ email?: string }>;
  solicitationNumber?: string;
}

/**
 * SAM.gov (US federal).
 *
 * ⚠ This uses `sam.gov/api/prod/sgs/v1/search/`, the path the public site
 * calls. It works without a key, but it is **undocumented and may change
 * without notice** — which is exactly why this provider degrades to `[]`
 * rather than failing the run. The documented `api.sam.gov` endpoint needs a
 * free registered API key; switch to it when one is available.
 *
 * `sort=-modifiedDate` is required. Without it the feed returns notices from
 * 2018 regardless of the query.
 */
@Injectable()
export class SamGovProvider implements ProcurementProvider {
  readonly name = 'sam-gov' as const;
  private readonly logger = new Logger(SamGovProvider.name);

  constructor(private readonly http: SourceHttpClient) {}

  async fetchSince(since: Date): Promise<ProcurementNotice[]> {
    const url =
      'https://sam.gov/api/prod/sgs/v1/search/?index=opp&sort=-modifiedDate' +
      '&page=0&size=100&q=' +
      encodeURIComponent('software OR website OR "information technology"');

    try {
      // `accept: application/json` is rejected with 406 by this endpoint;
      // `*/*` is accepted. Measured, not guessed — see the header matrix in
      // the P24 commit message.
      const body = await this.http.getJson<{
        _embedded?: { results?: SamResult[] };
        results?: SamResult[];
      }>({
        url,
        minIntervalMs: 600,
        headers: {
          accept: '*/*',
          'user-agent': 'RubicoLeadEngine/0.1 (+mailto:marvin.mukul@rubicotech.in)',
        },
      });

      const results = body?._embedded?.results ?? body?.results ?? [];

      return results.flatMap((result) => {
        const title = result.title;
        if (!title) return [];

        const publishedAt = result.publishDate ? new Date(result.publishDate) : new Date();
        // The feed has no server-side date filter we can rely on, so the
        // watermark is applied here.
        if (publishedAt < since) return [];

        const email = result.pointOfContacts
          ?.map((contact) => contact.email)
          .find((value): value is string => Boolean(value));

        // SAM has no single buyer-name field on this path; the contact's
        // domain is the identity, and the agency name is not reliably present.
        const buyerName = email ? (email.split('@')[1] ?? title) : title;

        return [
          {
            id: result._id ?? result.solicitationNumber ?? title,
            buyerName,
            ...(email ? { buyerEmail: email } : {}),
            title,
            ...(result.descriptions?.[0]?.content
              ? { description: result.descriptions[0].content.slice(0, 2000) }
              : {}),
            ...(result.psc?.[0]?.code ? { classification: result.psc[0].code } : {}),
            publishedAt,
            noticeUrl: `https://sam.gov/opp/${result._id ?? ''}/view`,
          } satisfies ProcurementNotice,
        ];
      });
    } catch (error) {
      this.logger.warn(`SAM.gov unavailable: ${describe(error)}`);
      return [];
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

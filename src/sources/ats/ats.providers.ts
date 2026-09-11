import { Injectable } from '@nestjs/common';
import { SourceHttpClient } from '../http/source-http.client.js';
import type { AtsPosting, AtsProvider } from './ats-provider.interface.js';

/**
 * The three Phase 0 board APIs. All are free, unauthenticated and public, so
 * they stay outside MeteredClient (FR-B2 covers billable calls).
 *
 * Each returns null for a board that does not exist, so a stale `atsSlug`
 * degrades to "no postings" rather than failing the whole run.
 */

@Injectable()
export class GreenhouseProvider implements AtsProvider {
  readonly name = 'greenhouse' as const;

  constructor(private readonly http: SourceHttpClient) {}

  async listPostings(slug: string): Promise<AtsPosting[] | null> {
    const body = await this.http.getJson<{
      jobs?: Array<{
        id: number;
        title: string;
        absolute_url: string;
        updated_at: string;
        first_published?: string;
        location?: { name?: string };
      }>;
    }>({
      url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
      acceptMissing: true,
    });

    if (!body?.jobs) return null;
    return body.jobs.map((job) => ({
      id: String(job.id),
      title: job.title,
      url: job.absolute_url,
      postedAt: new Date(job.updated_at ?? job.first_published ?? Date.now()),
      ...(job.location?.name ? { location: job.location.name } : {}),
    }));
  }
}

@Injectable()
export class LeverProvider implements AtsProvider {
  readonly name = 'lever' as const;

  constructor(private readonly http: SourceHttpClient) {}

  async listPostings(slug: string): Promise<AtsPosting[] | null> {
    const body = await this.http.getJson<
      | Array<{
          id: string;
          text: string;
          hostedUrl: string;
          createdAt: number;
          categories?: { location?: string; team?: string };
        }>
      // Lever answers 200 with {ok:false} for an unknown board.
      | { ok: false; error: string }
    >({
      url: `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
      acceptMissing: true,
    });

    if (!Array.isArray(body)) return null;
    return body.map((job) => ({
      id: job.id,
      title: job.text,
      url: job.hostedUrl,
      postedAt: new Date(job.createdAt),
      ...(job.categories?.location ? { location: job.categories.location } : {}),
      ...(job.categories?.team ? { department: job.categories.team } : {}),
    }));
  }
}

@Injectable()
export class AshbyProvider implements AtsProvider {
  readonly name = 'ashby' as const;

  constructor(private readonly http: SourceHttpClient) {}

  async listPostings(slug: string): Promise<AtsPosting[] | null> {
    const body = await this.http.getJson<{
      jobs?: Array<{
        id: string;
        title: string;
        jobUrl: string;
        publishedAt?: string;
        department?: string;
        location?: string;
        isListed?: boolean;
      }>;
    }>({
      url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
      acceptMissing: true,
    });

    if (!body?.jobs) return null;
    return body.jobs
      .filter((job) => job.isListed !== false)
      .map((job) => ({
        id: job.id,
        title: job.title.trim(),
        url: job.jobUrl,
        postedAt: job.publishedAt ? new Date(job.publishedAt) : new Date(),
        ...(job.location ? { location: job.location } : {}),
        ...(job.department ? { department: job.department } : {}),
      }));
  }
}

// ── P26: the mid-market / non-tech-skewed providers ────────────────────────
// Greenhouse/Lever/Ashby skew technology startups — the exact bias the
// broadening corrects for. Workable, SmartRecruiters and Recruitee are used
// heavily by agencies, manufacturers, retailers and mid-market employers —
// closer to Rubico's actual client base (§1.6).

interface WorkableJob {
  shortcode?: string;
  id?: string | number;
  title: string;
  url?: string;
  department?: string;
  published_on?: string;
  created_at?: string;
  location?: { city?: string; region?: string; country?: string };
}

/**
 * Workable's public embeddable-widget API. Endpoint and top-level envelope
 * (`{name, description, jobs}`) verified live 2026-09-11 against several
 * real accounts (a 404 on an unknown account confirms non-existence, which
 * is what P26's slug discovery depends on). No account probed at the time
 * had open jobs, so the per-job field names below follow Workable's
 * documented widget schema rather than a live sample — verify against a
 * real account with postings before relying on `location`/`department`.
 */
@Injectable()
export class WorkableProvider implements AtsProvider {
  readonly name = 'workable' as const;

  constructor(private readonly http: SourceHttpClient) {}

  async listPostings(slug: string): Promise<AtsPosting[] | null> {
    const body = await this.http.getJson<{ jobs?: WorkableJob[] }>({
      url: `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
      acceptMissing: true,
    });

    if (!body?.jobs) return null;
    return body.jobs.map((job) => ({
      id: String(job.shortcode ?? job.id ?? job.title),
      title: job.title,
      url: job.url ?? `https://apply.workable.com/${encodeURIComponent(slug)}/j/${job.shortcode ?? ''}`,
      postedAt: job.published_on
        ? new Date(job.published_on)
        : job.created_at
          ? new Date(job.created_at)
          : new Date(),
      ...(job.location?.city
        ? { location: [job.location.city, job.location.country].filter(Boolean).join(', ') }
        : {}),
      ...(job.department ? { department: job.department } : {}),
    }));
  }
}

interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string;
  ref?: { jobAdUrl?: string };
  location?: { city?: string; region?: string; country?: string };
  department?: { label?: string };
}

/**
 * SmartRecruiters' public Postings API. Endpoint and envelope
 * (`{offset, limit, totalFound, content}`) verified live 2026-09-11.
 *
 * ⚠ Unlike the other five providers, this endpoint returns HTTP 200 with
 * `totalFound: 0` for a company identifier that does not exist at all —
 * measured against six real and guessed identifiers, all 200. There is no
 * reliable "board not found" signal here, so `listPostings` never returns
 * null; P26's slug-discovery enricher deliberately excludes this provider
 * from its matching logic for that reason (see ats-slug-discovery.enricher.ts)
 * even though it is registered normally for ingestion.
 */
@Injectable()
export class SmartRecruitersProvider implements AtsProvider {
  readonly name = 'smartrecruiters' as const;

  constructor(private readonly http: SourceHttpClient) {}

  async listPostings(slug: string): Promise<AtsPosting[] | null> {
    const body = await this.http.getJson<{ content?: SmartRecruitersPosting[] }>({
      url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`,
      acceptMissing: true,
    });

    if (!body) return null;
    return (body.content ?? []).map((posting) => ({
      id: posting.id,
      title: posting.name,
      url: posting.ref?.jobAdUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${posting.id}`,
      postedAt: posting.releasedDate ? new Date(posting.releasedDate) : new Date(),
      ...(posting.location?.city ? { location: posting.location.city } : {}),
      ...(posting.department?.label ? { department: posting.department.label } : {}),
    }));
  }
}

interface RecruiteeOffer {
  id?: number | string;
  title?: string;
  slug: string;
  published_at?: string;
  created_at?: string;
  locations?: Array<{ city?: string; country?: string }>;
}

/**
 * Recruitee's public per-tenant offers API. Endpoint, envelope
 * (`{offers: [...]}`) and the full per-offer shape verified live 2026-09-11
 * against a real tenant (`channable`) with open roles. A nonexistent tenant
 * subdomain reliably 404s — verified against eight guessed tenants, all 404
 * bar the one real one — so `listPostings` returning null is trustworthy
 * here, unlike SmartRecruiters.
 */
@Injectable()
export class RecruiteeProvider implements AtsProvider {
  readonly name = 'recruitee' as const;

  constructor(private readonly http: SourceHttpClient) {}

  async listPostings(slug: string): Promise<AtsPosting[] | null> {
    const body = await this.http.getJson<{ offers?: RecruiteeOffer[] }>({
      url: `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
      acceptMissing: true,
    });

    if (!body?.offers) return null;
    return body.offers.map((offer) => ({
      id: String(offer.id ?? offer.slug),
      title: offer.title ?? offer.slug,
      url: `https://${slug}.recruitee.com/o/${offer.slug}`,
      postedAt: offer.published_at
        ? new Date(offer.published_at)
        : offer.created_at
          ? new Date(offer.created_at)
          : new Date(),
      ...(offer.locations?.[0]?.city ? { location: offer.locations[0].city } : {}),
    }));
  }
}

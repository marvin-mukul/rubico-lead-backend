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

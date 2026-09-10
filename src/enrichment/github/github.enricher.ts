import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import { MeteredClient } from '../../common/metering/index.js';
import type { CompanyModel as Company } from '../../generated/prisma/models.js';
import type { Enricher, EnrichmentResult } from '../enricher.interface.js';

interface GithubOrg {
  login: string;
  public_repos?: number;
  followers?: number;
  blog?: string;
  created_at?: string;
  updated_at?: string;
}

interface GithubRepo {
  language?: string | null;
  pushed_at?: string;
  archived?: boolean;
  fork?: boolean;
}

/**
 * GitHub org activity.
 *
 * Free at this volume, but routed through MeteredClient at zero cost anyway,
 * so consumption is visible in `api_usage` alongside everything else. The day
 * this becomes billable, or the day someone asks where the rate limit went,
 * the rows are already there — retrofitting a call site is exactly what FR-B4
 * warns about.
 */
@Injectable()
export class GithubEnricher implements Enricher {
  readonly name = 'github';
  readonly cost = 'free' as const;

  private readonly logger = new Logger(GithubEnricher.name);

  constructor(
    private readonly metered: MeteredClient,
    private readonly config: AppConfigService,
  ) {}

  async enrich(company: Company): Promise<EnrichmentResult> {
    // The org login is guessed from the domain's first label. A miss is
    // common and harmless — it simply yields no GitHub facts.
    const login = company.canonicalDomain.split('.')[0];

    const org = await this.metered.call({
      provider: 'github',
      operation: 'org',
      estimatedCost: 0,
      execute: () => this.get<GithubOrg>(`https://api.github.com/orgs/${login}`),
      computeCost: () => 0,
    });

    if (!org) return {};

    const repos =
      (await this.metered.call({
        provider: 'github',
        operation: 'repos',
        estimatedCost: 0,
        execute: () =>
          this.get<GithubRepo[]>(
            `https://api.github.com/orgs/${login}/repos?sort=pushed&per_page=30`,
          ),
        computeCost: () => 0,
      })) ?? [];

    const active = repos.filter((repo) => !repo.archived && !repo.fork);
    const languages = [
      ...new Set(active.map((repo) => repo.language).filter((l): l is string => Boolean(l))),
    ].slice(0, 8);
    const lastPush = active
      .map((repo) => repo.pushed_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);

    return {
      detectedStack: {
        githubOrg: org.login,
        githubPublicRepos: org.public_repos ?? 0,
        githubLanguages: languages,
        ...(lastPush ? { githubLastPushAt: lastPush } : {}),
      },
    };
  }

  private async get<T>(url: string): Promise<T | null> {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.config.githubToken}`,
        'user-agent': 'RubicoLeadEngine/0.1',
      },
      signal: AbortSignal.timeout(8_000),
    });

    // A company with no GitHub org is the common case, not an error.
    if (response.status === 404) return null;
    if (response.status === 403 || response.status === 429) {
      this.logger.warn(`GitHub rate limited on ${url}`);
      return null;
    }
    if (!response.ok) throw new Error(`GitHub ${response.status} for ${url}`);
    return (await response.json()) as T;
  }
}

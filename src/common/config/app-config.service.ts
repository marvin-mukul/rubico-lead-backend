import { Injectable } from '@nestjs/common';
import type { Env, LlmProviderName } from './env.schema.js';
import { PriceTable } from './price-table.js';

/**
 * The only place in the application that holds environment values.
 *
 * Nothing outside `common/config` may read `process.env` — inject this instead.
 * Grouped getters exist so downstream modules depend on a concept
 * ("the classify provider") rather than on a variable name.
 */
@Injectable()
export class AppConfigService {
  constructor(
    private readonly env: Env,
    readonly prices: PriceTable,
  ) {}

  // ── Runtime ──────────────────────────────────────────────────────────────
  get nodeEnv(): Env['NODE_ENV'] {
    return this.env.NODE_ENV;
  }
  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
  get port(): number {
    return this.env.PORT;
  }
  get bindAddress(): string {
    return this.env.BIND_ADDRESS;
  }
  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  get auth() {
    return {
      internalApiToken: this.env.INTERNAL_API_TOKEN,
      sessionSecret: this.env.SESSION_SECRET,
      dashboardEmail: this.env.DASHBOARD_EMAIL,
      dashboardPasswordHash: this.env.DASHBOARD_PASSWORD_HASH,
    } as const;
  }

  // ── Outbound to n8n (§8.2) ───────────────────────────────────────────────
  get n8n() {
    return {
      alertWebhookUrl: this.env.N8N_ALERT_WEBHOOK_URL,
      webhookToken: this.env.N8N_WEBHOOK_TOKEN,
    } as const;
  }

  // ── LLM selection (FR-B20) ───────────────────────────────────────────────
  get classify() {
    return {
      provider: this.env.LLM_CLASSIFY_PROVIDER,
      model: this.env.LLM_CLASSIFY_MODEL,
      batch: false,
    } as const;
  }

  get brief() {
    return {
      provider: this.env.LLM_BRIEF_PROVIDER,
      model: this.env.LLM_BRIEF_MODEL,
      batch: this.env.LLM_BRIEF_BATCH,
    } as const;
  }

  apiKeyFor(provider: LlmProviderName): string {
    return provider === 'gemini' ? this.env.GEMINI_API_KEY : this.env.ANTHROPIC_API_KEY;
  }

  get githubToken(): string {
    return this.env.GITHUB_TOKEN;
  }
  get productHuntToken(): string {
    return this.env.PRODUCT_HUNT_TOKEN;
  }

  // ── Cost caps (§6) ───────────────────────────────────────────────────────
  get caps() {
    return {
      monthlyUsd: this.env.MONTHLY_CAP_USD,
      dailyUsd: this.env.DAILY_CAP_USD,
      perLeadUsd: this.env.PER_LEAD_BUDGET_USD,
    } as const;
  }

  /**
   * FR-C2: the hard cap is per provider. Falls back to the global monthly cap
   * when no provider-specific override is set.
   */
  monthlyCapFor(provider: string): number {
    const overrides: Record<string, number | undefined> = {
      gemini: this.env.GEMINI_MONTHLY_CAP_USD,
      anthropic: this.env.ANTHROPIC_MONTHLY_CAP_USD,
    };
    return overrides[provider] ?? this.env.MONTHLY_CAP_USD;
  }

  // ── Sources ──────────────────────────────────────────────────────────────
  /** FR-B21: mandatory on every SEC request. */
  get secUserAgent(): string {
    return this.env.SEC_USER_AGENT;
  }
}

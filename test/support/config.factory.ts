// Imported from the leaf modules, NOT the `config/index.js` barrel: the barrel
// re-exports config.module.ts, whose `ConfigModule.forRoot({ validate })` runs at
// import time and would validate the real environment just to run a unit test.
import { AppConfigService } from '../../src/common/config/app-config.service.js';
import { PriceTable } from '../../src/common/config/price-table.js';
import type { Env } from '../../src/common/config/env.schema.js';

/**
 * An AppConfigService for tests, without needing a full valid environment.
 * Only override the keys the test under examination actually reads.
 */
export function testConfig(overrides: Partial<Env> = {}): AppConfigService {
  const env = {
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lead_engine',
    NODE_ENV: 'test',
    PORT: 3000,
    BIND_ADDRESS: '127.0.0.1',
    INTERNAL_API_TOKEN: 'test-internal-token-000000000000000000',
    SESSION_SECRET: 'test-session-secret-00000000000000000',
    DASHBOARD_EMAIL: 'dash@rubico.tech',
    DASHBOARD_PASSWORD_HASH: '',
    N8N_ALERT_WEBHOOK_URL: 'http://localhost:5678/webhook/test',
    N8N_WEBHOOK_TOKEN: 'test-webhook-token',
    LLM_CLASSIFY_PROVIDER: 'gemini',
    LLM_CLASSIFY_MODEL: 'gemini-2.5-flash-lite',
    LLM_BRIEF_PROVIDER: 'anthropic',
    LLM_BRIEF_MODEL: 'claude-sonnet-5',
    LLM_BRIEF_BATCH: true,
    GEMINI_API_KEY: 'test',
    ANTHROPIC_API_KEY: 'test',
    GITHUB_TOKEN: 'test',
    PRODUCT_HUNT_TOKEN: 'test',
    MONTHLY_CAP_USD: 25,
    DAILY_CAP_USD: 1.5,
    PER_LEAD_BUDGET_USD: 0.1,
    PRICE_TABLE_PATH: './config/pricing.json',
    CAPABILITY_MAP_PATH: './config/capability-map.json',
    ARCHETYPE_PATH: './config/archetypes.json',
    TRIGGER_PATH: './config/triggers.json',
    EVIDENCE_PATH: './config/evidence.json',
    SEC_USER_AGENT: 'Rubico Lead Engine (test@rubico.tech)',
    ...overrides,
  } as Env;

  return new AppConfigService(env, new PriceTable({}));
}

import { z } from 'zod';

/**
 * Typed environment schema — requirement.md §10.
 *
 * FR-B20: model and provider selection is config, not code.
 * FR-B21: SEC_USER_AGENT must identify Rubico with a contact address.
 *
 * Every variable the application will ever read is declared here. Nothing else
 * in the codebase may touch `process.env` (see AppConfigService).
 */

/** `''` and `undefined` both mean "not set" for an env var. */
const unset = (v: unknown): boolean => v === undefined || v === null || v === '';

/** Number from an env string, with an optional default. */
const envNumber = (def?: number) =>
  z.preprocess((v) => (unset(v) ? def : Number(v)), z.number({ error: 'must be a number' }));

/** Boolean from an env string: 1/true/yes/on are true, everything else false. */
const envBoolean = (def: boolean) =>
  z.preprocess((v) => {
    if (unset(v)) return def;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
  }, z.boolean());

/** A positive USD amount. */
const usd = (def?: number) => envNumber(def).pipe(z.number().nonnegative());

const secret = (min: number, label: string) =>
  z.string().min(min, `${label} must be at least ${min} characters`);

export const LLM_PROVIDERS = ['gemini', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const envSchema = z.object({
  // ── Runtime ──────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      error: 'must be a postgres:// or postgresql:// connection string',
    }),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: envNumber(3000).pipe(z.number().int().min(1).max(65535)),
  // FR-B15: bind to loopback in production when Next and n8n are co-hosted.
  BIND_ADDRESS: z.string().min(1).default('127.0.0.1'),

  // ── Auth (§8.1, §8.3) ────────────────────────────────────────────────────
  INTERNAL_API_TOKEN: secret(32, 'INTERNAL_API_TOKEN'),
  SESSION_SECRET: secret(32, 'SESSION_SECRET'),
  DASHBOARD_EMAIL: z.email(),
  DASHBOARD_PASSWORD_HASH: z.string().min(1),

  // ── Outbound to n8n (§8.2) ───────────────────────────────────────────────
  N8N_ALERT_WEBHOOK_URL: z.url(),
  N8N_WEBHOOK_TOKEN: z.string().min(1),

  // ── LLM selection (§11, FR-B20) ──────────────────────────────────────────
  LLM_CLASSIFY_PROVIDER: z.enum(LLM_PROVIDERS).default('gemini'),
  LLM_CLASSIFY_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
  LLM_BRIEF_PROVIDER: z.enum(LLM_PROVIDERS).default('anthropic'),
  LLM_BRIEF_MODEL: z.string().min(1).default('claude-sonnet-5'),
  // FR-AI3: briefs go through the batch endpoint (50% off).
  LLM_BRIEF_BATCH: envBoolean(true),

  // ── Provider credentials ─────────────────────────────────────────────────
  GEMINI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  PRODUCT_HUNT_TOKEN: z.string().min(1),

  // ── Cost caps (§6) ───────────────────────────────────────────────────────
  MONTHLY_CAP_USD: usd(25),
  DAILY_CAP_USD: usd(1.5),
  PER_LEAD_BUDGET_USD: usd(0.1),
  // FR-C2 is a hard cap *per provider*, and §6.3 sets GEMINI_MONTHLY_CAP_USD
  // directly. §10 lists only the global cap, so these are optional overrides
  // that fall back to MONTHLY_CAP_USD.
  GEMINI_MONTHLY_CAP_USD: usd().optional(),
  ANTHROPIC_MONTHLY_CAP_USD: usd().optional(),

  // FR-C9: the price table lives in config, not code. Rates move.
  PRICE_TABLE_PATH: z.string().min(1).default('./config/pricing.json'),

  // §2.3: `scoring_config.value` is a Float, so list- and tree-shaped config
  // (capability map, archetypes, trigger families, evidence rules) lives in
  // JSON files following the PRICE_TABLE_PATH precedent. Numeric weights stay
  // in scoring_config where a human can PATCH them (FR-SC3).
  CAPABILITY_MAP_PATH: z.string().min(1).default('./config/capability-map.json'),
  ARCHETYPE_PATH: z.string().min(1).default('./config/archetypes.json'),
  TRIGGER_PATH: z.string().min(1).default('./config/triggers.json'),
  EVIDENCE_PATH: z.string().min(1).default('./config/evidence.json'),

  // ── Sources ──────────────────────────────────────────────────────────────
  // SEC Form D carries no website for the filer, so `ingest.sec-edgar` needs
  // a name -> domain step to attach signals to a company at all. `none` (the
  // default) resolves nothing and counts those records as filtered out;
  // `clearbit` uses the free autocomplete endpoint with exact-name matching.
  // See sources/domain-resolver for why the conservative option is default.
  SEC_DOMAIN_RESOLVER: z.enum(['none', 'clearbit']).default('none'),

  // Pain-signal searches for the Hacker News source. Comma-separated, in
  // config rather than code so the queries can be tuned without a deploy.
  HACKERNEWS_QUERIES: z
    .string()
    .min(1)
    .default('legacy system,legacy codebase,technical debt,migrating off,rewrite our'),

  /**
   * Which procurement feeds to ingest, comma-separated.
   *
   * `ted-eu` is OFF by default, and that is a targeting decision rather than
   * a technical one. It works — it discovered 612 organisations — but they
   * are European public-sector buyers: non-English, and legally required to
   * purchase through tender rather than through an outbound email. For a
   * US-focused outbound engine it is 95% of the corpus and 0% of the
   * addressable market, which is worse than no source at all because a
   * reviewer has to scroll past it.
   *
   * Nothing is deleted: re-adding `ted-eu` here turns it straight back on,
   * and the organisations it already found stay in the database.
   */
  PROCUREMENT_FEEDS: z
    .string()
    .default('uk-contracts-finder,sam-gov'),

  /**
   * How many "Ask HN: Who is hiring?" threads to read per run.
   *
   * 3 keeps a rolling quarter fresh. Raise it once — 12, say — to backfill a
   * year in a single run: each thread is ~190 companies, so 12 is ~2,300, and
   * re-reading a thread costs nothing because the signals dedupe.
   */
  HN_HIRING_THREADS: z.coerce.number().int().min(1).max(36).default(3),

  // P25: press-release RSS feeds (signal type S7), comma-separated. Verified
  // live 2026-09-11 — the PRNewswire technology/software category feed
  // returns real releases with no key. BusinessWire needs a real registered
  // channel-id feed URL (its RSS is per-topic, not a bare public endpoint);
  // add one here once available, same "config, not code" shape as HN.
  PRESS_RELEASE_FEEDS: z
    .string()
    .min(1)
    .default('https://www.prnewswire.com/rss/technology/computer-software-list.rss'),

  // FR-B21: SEC fair-access requires a User-Agent identifying us with a
  // contact address. Without it SEC will block the crawler.
  SEC_USER_AGENT: z
    .string()
    .min(1)
    .refine((v) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v), {
      error: 'must contain a contact email address (SEC fair-access requirement)',
    }),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate the environment. Throws with every problem listed, not
 * just the first — a boot failure should tell you everything that is wrong.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `  • ${key}: ${issue.message}`;
  });
  throw new Error(
    `Invalid environment — ${lines.length} problem(s) found.\n` +
      `${lines.join('\n')}\n` +
      `See requirement.md §10 and .env.example for the full list.`,
  );
}

let parsed: Env | null = null;

/** Used as `ConfigModule.forRoot({ validate })`. Caches for AppConfigService. */
export function validateEnv(raw: Record<string, unknown>): Env {
  parsed = parseEnv(raw);
  return parsed;
}

/** The validated environment. Only valid after ConfigModule has initialised. */
export function getValidatedEnv(): Env {
  if (!parsed) {
    throw new Error('Environment accessed before ConfigModule initialised.');
  }
  return parsed;
}

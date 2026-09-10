import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 no longer auto-loads `.env` — `dotenv/config` above does it, so the
 * CLI and the app read the same environment.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

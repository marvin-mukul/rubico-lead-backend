import { readFileSync } from 'node:fs';
import { testConfig } from '../../test/support/config.factory.js';
import { SIGNAL_TYPES } from '../common/domain/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { EVIDENCE_LEVELS } from '../opportunity/index.js';

/**
 * Guards the silent-zero class of bug.
 *
 * A signal type with no configured weight contributes **nothing** to intent,
 * with no error, no type complaint and no failing test. It happened: P25
 * added S7 (press releases) to `prisma/seed.ts`, but Prisma 7 does not run
 * the seed on `migrate`, so the running database never got `S7.weight`.
 * Press-release signals would have scored zero for as long as anyone cared
 * to look.
 *
 * Two checks, because there are two ways to get this wrong: forgetting to
 * add the key to the seed file, and forgetting to run the seed.
 */
describe('scoring config completeness', () => {
  const seed = readFileSync('prisma/seed.ts', 'utf8');

  describe('the seed file declares a default for everything', () => {
    it.each([...SIGNAL_TYPES])('declares %s weight and half-life', (type) => {
      expect(seed, `'${type}.weight' missing from prisma/seed.ts`).toContain(`'${type}.weight'`);
      expect(seed, `'${type}.halfLifeDays' missing from prisma/seed.ts`).toContain(
        `'${type}.halfLifeDays'`,
      );
    });

    it.each([...EVIDENCE_LEVELS])('declares an %s evidence multiplier', (level) => {
      expect(seed, `'evidence.${level}.multiplier' missing from prisma/seed.ts`).toContain(
        `'evidence.${level}.multiplier'`,
      );
    });
  });

  describe('the running database actually has them [integration]', () => {
    let prisma: PrismaService;
    let keys: Set<string>;

    beforeAll(async () => {
      prisma = new PrismaService(testConfig());
      await prisma.onModuleInit();
      const rows = await prisma.scoringConfig.findMany({ select: { key: true } });
      keys = new Set(rows.map((row) => row.key));
    });

    afterAll(async () => {
      await prisma.onModuleDestroy();
    });

    it('has a weight and half-life for every signal type', () => {
      const missing = SIGNAL_TYPES.flatMap((type) =>
        [`${type}.weight`, `${type}.halfLifeDays`].filter((key) => !keys.has(key)),
      );
      // If this fails, run `npm run db:seed` — Prisma 7 does not run the seed
      // as part of `migrate dev` or `migrate reset`.
      expect(missing, `missing from scoring_config: ${missing.join(', ')}`).toEqual([]);
    });

    it('has a multiplier for every evidence level', () => {
      const missing = EVIDENCE_LEVELS.map((level) => `evidence.${level}.multiplier`).filter(
        (key) => !keys.has(key),
      );
      expect(missing, `missing from scoring_config: ${missing.join(', ')}`).toEqual([]);
    });
  });

  /**
   * The rescore SQL hard-codes the signal types it knows about, in a regex
   * and two IN lists. A type absent from any of them contributes nothing to
   * intent — silently, and differently from `score.ts`, which would break
   * parity without the parity test necessarily exercising that type.
   */
  describe('the rescore SQL knows every signal type', () => {
    const sql = readFileSync('src/scoring/rescore.job.ts', 'utf8');

    it.each([...SIGNAL_TYPES])('%s appears in the rescore SQL', (type) => {
      // Event types are listed literally; the F-* types sit in the config regex.
      const inRegex = /\^\(([^)]*)\)/.exec(sql)?.[1] ?? '';
      const mentioned =
        sql.includes(`'${type}'`) ||
        inRegex.includes(type) ||
        // S1..S7 are collapsed into a character-class range.
        new RegExp(`S\\[1-([1-9])\\]`).test(inRegex) &&
          /^S(\d)$/.test(type) &&
          Number(/^S(\d)$/.exec(type)![1]) <= Number(/S\[1-([1-9])\]/.exec(inRegex)![1]);

      expect(mentioned, `${type} is not referenced in rescore.job.ts`).toBe(true);
    });
  });
});

import { Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { AppConfigService } from '../common/config/app-config.service.js';

const { Client } = pg;

export interface AdvisoryLock {
  readonly key: string;
  release(): Promise<void>;
}

/**
 * FR-B6: concurrency is prevented by a Postgres advisory lock keyed on the
 * job name.
 *
 * A session-level `pg_try_advisory_lock` is held for the life of the
 * connection that took it. Prisma runs each query on an arbitrary pooled
 * connection, so a lock taken through Prisma would not reliably be held — or
 * released — by the same connection across a long ingestion run. This service
 * therefore holds a dedicated `pg.Client` per lock and closes it on release.
 *
 * Closing the connection is also the safety net: if the process dies mid-run,
 * Postgres drops the session and the lock goes with it, so a crashed run never
 * blocks the next trigger forever.
 */
@Injectable()
export class AdvisoryLockService {
  private readonly logger = new Logger(AdvisoryLockService.name);

  constructor(private readonly config: AppConfigService) {}

  /** Returns null when another session already holds the lock. */
  async tryAcquire(key: string): Promise<AdvisoryLock | null> {
    const client = new Client({ connectionString: this.config.databaseUrl });
    await client.connect();

    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [key],
      );
      if (!result.rows[0]?.acquired) {
        await client.end();
        return null;
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }

    this.logger.debug(`Acquired advisory lock ${key}`);

    let released = false;
    return {
      key,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        } catch (error) {
          this.logger.warn(
            `Failed to unlock ${key} cleanly; closing the connection releases it anyway: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          await client.end().catch(() => undefined);
          this.logger.debug(`Released advisory lock ${key}`);
        }
      },
    };
  }
}

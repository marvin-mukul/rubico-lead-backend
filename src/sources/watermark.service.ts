import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a source resumes from.
 *
 * Derived from `job_runs` rather than a new table: the last successful run of
 * `ingest.<source>` is by definition the point everything before it was
 * already ingested. §5 fixes the schema at eight tables, and dedupe makes a
 * slightly-too-early watermark harmless — re-reading a day costs one wasted
 * fetch, not a duplicate row.
 */
@Injectable()
export class WatermarkService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param override  `since` from the trigger body, which always wins.
   * @param fallbackDays  How far back to look on the very first run.
   */
  async since(jobName: string, override?: Date, fallbackDays = 3): Promise<Date> {
    if (override) return override;

    const lastSuccess = await this.prisma.jobRun.findFirst({
      where: { jobName, status: 'succeeded', finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });

    if (lastSuccess?.finishedAt) return lastSuccess.finishedAt;
    return new Date(Date.now() - fallbackDays * DAY_MS);
  }
}

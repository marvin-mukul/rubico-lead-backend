import { Logger } from '@nestjs/common';
import type { JobContext, JobHandler } from '../jobs/index.js';
import { IngestionService } from './ingestion.service.js';
import type { SignalSource } from './signal-source.interface.js';
import { SourceHealthService } from './source-health.service.js';
import { WatermarkService } from './watermark.service.js';

/**
 * Never fetch further back than this, however stale the watermark.
 *
 * Matches `compound.windowDays`: evidence older than a quarter cannot lift a
 * company out of `ignore` on its own (FR-SC4 cuts off at 30 days), and its
 * only remaining use is as compound evidence alongside something fresh. For
 * procurement it is also the point where a tender has almost certainly
 * closed — an expired tender is context, not an opportunity.
 */
const MAX_LOOKBACK_DAYS = 90;

/**
 * One `ingest.<source>` job per source (§7.2). Every source gets the same
 * job shape, so adding a source is a provider plus a registry line and never
 * a new job implementation (FR-B1).
 */
export class IngestJobHandler implements JobHandler {
  readonly name: string;
  private readonly logger: Logger;

  constructor(
    private readonly source: SignalSource,
    private readonly ingestion: IngestionService,
    private readonly watermarks: WatermarkService,
    private readonly health: SourceHealthService,
    private readonly fallbackDays = 3,
  ) {
    this.name = `ingest.${source.name}`;
    this.logger = new Logger(`Ingest:${source.name}`);
  }

  async run(context: JobContext): Promise<void> {
    const watermark = await this.watermarks.since(this.name, context.since, this.fallbackDays);
    const floor = new Date(Date.now() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const since = watermark < floor ? floor : watermark;

    if (since > watermark) {
      this.logger.warn(
        `Watermark ${watermark.toISOString().slice(0, 10)} is older than the ` +
          `${MAX_LOOKBACK_DAYS}-day floor; fetching from ${since.toISOString().slice(0, 10)} instead`,
      );
    }
    this.logger.log(`Fetching ${this.source.name} since ${since.toISOString()}`);

    try {
      const raw = await this.source.fetch(since);
      this.logger.log(`${this.source.name} returned ${raw.length} raw signal(s)`);
      await this.ingestion.ingest(raw, context);
    } catch (error) {
      // The runner records the failure itself; this only decides whether the
      // source has now been down long enough to be worth alerting (NFR-8).
      // Awaited so the alert is sent before the run is marked failed — a
      // fire-and-forget here would race the process exiting.
      const message = error instanceof Error ? error.message : String(error);
      await this.health.reportFailure(this.source.name, this.name, message);
      throw error;
    }
  }
}

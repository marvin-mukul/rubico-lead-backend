import { Logger } from '@nestjs/common';
import type { JobContext, JobHandler } from '../jobs/index.js';
import { IngestionService } from './ingestion.service.js';
import type { SignalSource } from './signal-source.interface.js';
import { SourceHealthService } from './source-health.service.js';
import { WatermarkService } from './watermark.service.js';

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
    const since = await this.watermarks.since(this.name, context.since, this.fallbackDays);
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

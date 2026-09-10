import { Logger } from '@nestjs/common';
import type { JobContext, JobHandler } from '../jobs/index.js';
import { EnrichmentService } from './enrichment.service.js';

/**
 * `maintenance.reverify-legacy` — weekly (§7.2, FR-S5).
 *
 * Re-fingerprints companies currently carrying an `F-LEG` signal. A company
 * that has since modernised loses the flag and the signal, so the engine
 * stops pitching a rebuild to someone who already did one — the single most
 * embarrassing way for this to be wrong in front of a human.
 */
export class ReverifyLegacyJob implements JobHandler {
  readonly name = 'maintenance.reverify-legacy';
  private readonly logger = new Logger('Job:reverify-legacy');

  constructor(private readonly enrichment: EnrichmentService) {}

  async run(context: JobContext): Promise<void> {
    const companies = await this.enrichment.findLegacyFlagged();
    this.logger.log(`Re-verifying ${companies.length} legacy-flagged company(ies)`);
    context.count('fetched', companies.length);
    await this.enrichment.enrichBatch(companies, context);
  }
}

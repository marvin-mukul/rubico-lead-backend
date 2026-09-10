import { Module, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service.js';
import { CompaniesModule } from '../companies/index.js';
import { JobRegistry } from '../jobs/index.js';
import { SignalsModule } from '../signals/index.js';
import { ClearbitAutocompleteResolver } from './domain-resolver/clearbit-autocomplete.resolver.js';
import { DOMAIN_RESOLVER } from './domain-resolver/domain-resolver.interface.js';
import { NullDomainResolver } from './domain-resolver/null-domain.resolver.js';
import { SourceHttpClient } from './http/source-http.client.js';
import { IngestJobHandler } from './ingest-job.handler.js';
import { IngestionService } from './ingestion.service.js';
import { SecEdgarSource } from './sec-edgar/sec-edgar.source.js';
import { SIGNAL_SOURCE, type SignalSource } from './signal-source.interface.js';
import { SourceHealthService } from './source-health.service.js';
import { WatermarkService } from './watermark.service.js';

/**
 * Every source is bound to the SIGNAL_SOURCE multi-token and gets its
 * `ingest.<name>` job generated from the same handler (FR-B1). Adding a
 * source is a provider class plus one line in the array below — no new job,
 * no call-site edit.
 */
@Module({
  imports: [CompaniesModule, SignalsModule],
  providers: [
    SourceHttpClient,
    WatermarkService,
    SourceHealthService,
    IngestionService,

    // Domain resolution is selected by config, not code (FR-B20).
    NullDomainResolver,
    ClearbitAutocompleteResolver,
    {
      provide: DOMAIN_RESOLVER,
      inject: [AppConfigService, NullDomainResolver, ClearbitAutocompleteResolver],
      useFactory: (
        config: AppConfigService,
        none: NullDomainResolver,
        clearbit: ClearbitAutocompleteResolver,
      ) => (config.secDomainResolver === 'clearbit' ? clearbit : none),
    },

    SecEdgarSource,
    {
      provide: SIGNAL_SOURCE,
      inject: [SecEdgarSource],
      useFactory: (...sources: SignalSource[]) => sources,
    },
  ],
  exports: [IngestionService, SIGNAL_SOURCE, SourceHttpClient],
})
export class SourcesModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly ingestion: IngestionService,
    private readonly watermarks: WatermarkService,
    private readonly health: SourceHealthService,
    private readonly secEdgar: SecEdgarSource,
  ) {}

  onModuleInit(): void {
    for (const source of [this.secEdgar]) {
      this.registry.register(
        new IngestJobHandler(source, this.ingestion, this.watermarks, this.health),
      );
    }
  }
}

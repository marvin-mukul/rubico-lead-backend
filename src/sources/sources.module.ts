import { Module, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service.js';
import { CompaniesModule } from '../companies/index.js';
import { JobRegistry } from '../jobs/index.js';
import { SignalsModule } from '../signals/index.js';
import { AtsSlugDiscoveryEnricher } from './ats/ats-slug-discovery.enricher.js';
import { AtsSource } from './ats/ats.source.js';
import { ATS_PROVIDER } from './ats/ats-provider.interface.js';
import {
  AshbyProvider,
  GreenhouseProvider,
  LeverProvider,
  RecruiteeProvider,
  SmartRecruitersProvider,
  WorkableProvider,
} from './ats/ats.providers.js';
import { ClearbitAutocompleteResolver } from './domain-resolver/clearbit-autocomplete.resolver.js';
import { DOMAIN_RESOLVER } from './domain-resolver/domain-resolver.interface.js';
import { NullDomainResolver } from './domain-resolver/null-domain.resolver.js';
import { FirstPartyController } from './first-party/first-party.controller.js';
import { HackerNewsSource } from './hackernews/hackernews.source.js';
import { SourceHttpClient } from './http/source-http.client.js';
import { IngestJobHandler } from './ingest-job.handler.js';
import { IngestionService } from './ingestion.service.js';
import { PressReleaseSource } from './press-release/press-release.source.js';
import { ProductHuntSource } from './product-hunt/product-hunt.source.js';
import { PROCUREMENT_PROVIDER } from './procurement/procurement-provider.interface.js';
import {
  SamGovProvider,
  TedProvider,
  UkContractsFinderProvider,
} from './procurement/procurement.providers.js';
import { ProcurementSource } from './procurement/procurement.source.js';
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
  controllers: [FirstPartyController],
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

    GreenhouseProvider,
    LeverProvider,
    AshbyProvider,
    WorkableProvider,
    SmartRecruitersProvider,
    RecruiteeProvider,
    {
      provide: ATS_PROVIDER,
      inject: [
        GreenhouseProvider,
        LeverProvider,
        AshbyProvider,
        WorkableProvider,
        SmartRecruitersProvider,
        RecruiteeProvider,
      ],
      useFactory: (...providers: unknown[]) => providers,
    },
    AtsSlugDiscoveryEnricher,

    UkContractsFinderProvider,
    TedProvider,
    SamGovProvider,
    {
      provide: PROCUREMENT_PROVIDER,
      inject: [UkContractsFinderProvider, TedProvider, SamGovProvider],
      useFactory: (...providers: unknown[]) => providers,
    },

    SecEdgarSource,
    AtsSource,
    HackerNewsSource,
    ProductHuntSource,
    ProcurementSource,
    PressReleaseSource,
    {
      provide: SIGNAL_SOURCE,
      inject: [
        SecEdgarSource,
        AtsSource,
        HackerNewsSource,
        ProductHuntSource,
        ProcurementSource,
        PressReleaseSource,
      ],
      useFactory: (...sources: SignalSource[]) => sources,
    },
  ],
  exports: [IngestionService, SIGNAL_SOURCE, SourceHttpClient, AtsSlugDiscoveryEnricher],
})
export class SourcesModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly ingestion: IngestionService,
    private readonly watermarks: WatermarkService,
    private readonly health: SourceHealthService,
    private readonly secEdgar: SecEdgarSource,
    private readonly ats: AtsSource,
    private readonly hackerNews: HackerNewsSource,
    private readonly productHunt: ProductHuntSource,
    private readonly procurement: ProcurementSource,
    private readonly pressRelease: PressReleaseSource,
  ) {}

  onModuleInit(): void {
    const sources = [
      this.secEdgar,
      this.ats,
      this.hackerNews,
      this.productHunt,
      this.procurement,
      this.pressRelease,
    ];
    for (const source of sources) {
      this.registry.register(
        new IngestJobHandler(source, this.ingestion, this.watermarks, this.health),
      );
    }
  }
}

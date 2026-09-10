import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../jobs/index.js';
import { SignalsModule } from '../signals/index.js';
import { DnsEnricher } from './dns/dns.enricher.js';
import { ENRICHER, type Enricher } from './enricher.interface.js';
import { EnrichmentService } from './enrichment.service.js';
import { GithubEnricher } from './github/github.enricher.js';
import { HomepageFingerprintEnricher } from './homepage-fingerprint/homepage.enricher.js';
import { ReverifyLegacyJob } from './reverify-legacy.job.js';

@Module({
  imports: [SignalsModule],
  providers: [
    HomepageFingerprintEnricher,
    DnsEnricher,
    GithubEnricher,
    {
      provide: ENRICHER,
      inject: [HomepageFingerprintEnricher, DnsEnricher, GithubEnricher],
      useFactory: (...enrichers: Enricher[]) => enrichers,
    },
    EnrichmentService,
  ],
  exports: [EnrichmentService, ENRICHER],
})
export class EnrichmentModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly enrichment: EnrichmentService,
  ) {}

  onModuleInit(): void {
    this.registry.register(new ReverifyLegacyJob(this.enrichment));
  }
}

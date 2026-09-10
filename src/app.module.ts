import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './common/auth/index.js';
import { AppConfigModule } from './common/config/index.js';
import { IdempotencyModule } from './common/idempotency/index.js';
import { MeteringModule } from './common/metering/index.js';
import { PrismaModule } from './common/prisma/index.js';
import { PipelineModule } from './pipeline/index.js';
import { CompaniesModule } from './companies/index.js';
import { EnrichmentModule } from './enrichment/index.js';
import { JobsModule } from './jobs/index.js';
import { LlmModule } from './llm/index.js';
import { NotificationsModule } from './notifications/index.js';
import { ScoringConfigModule } from './scoring-config/index.js';
import { ScoringModule } from './scoring/index.js';
import { SignalsModule } from './signals/index.js';
import { SourcesModule } from './sources/index.js';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    IdempotencyModule,
    NotificationsModule,
    MeteringModule,
    JobsModule,
    ScoringConfigModule,
    CompaniesModule,
    SignalsModule,
    SourcesModule,
    EnrichmentModule,
    ScoringModule,
    LlmModule,
    PipelineModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

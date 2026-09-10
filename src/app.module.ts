import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './common/auth/index.js';
import { AppConfigModule } from './common/config/index.js';
import { IdempotencyModule } from './common/idempotency/index.js';
import { MeteringModule } from './common/metering/index.js';
import { PrismaModule } from './common/prisma/index.js';
import { CompaniesModule } from './companies/index.js';
import { JobsModule } from './jobs/index.js';
import { NotificationsModule } from './notifications/index.js';
import { ScoringConfigModule } from './scoring-config/index.js';

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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

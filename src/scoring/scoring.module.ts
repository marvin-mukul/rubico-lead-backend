import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import { JobRegistry } from '../jobs/index.js';
import { SignalsModule } from '../signals/index.js';
import { RescoreAllJob } from './rescore.job.js';
import { ScoringService } from './scoring.service.js';

@Module({
  imports: [SignalsModule],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(new RescoreAllJob(this.prisma));
  }
}

import { Module, OnModuleInit } from '@nestjs/common';
import { CompaniesModule } from '../companies/index.js';
import { EnrichmentModule } from '../enrichment/index.js';
import { JobRegistry } from '../jobs/index.js';
import { LlmModule } from '../llm/index.js';
import { ScoringModule } from '../scoring/index.js';
import { PipelineRunJob } from './pipeline-run.job.js';

/**
 * Lives in its own module rather than in `jobs/` (where the plan first put
 * it) because it depends on enrichment, companies, the LLM layer and
 * scoring. Putting it in JobsModule would make the job runner depend on
 * every domain module, and the runner is meant to know nothing about any
 * specific job.
 */
@Module({
  imports: [CompaniesModule, EnrichmentModule, ScoringModule, LlmModule],
  providers: [PipelineRunJob],
  exports: [PipelineRunJob],
})
export class PipelineModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly job: PipelineRunJob,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.job);
  }
}

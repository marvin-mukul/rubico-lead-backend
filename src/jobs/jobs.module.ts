import { Global, Module } from '@nestjs/common';
import { AdvisoryLockService } from './advisory-lock.service.js';
import { HealthController } from './health.controller.js';
import { JobRegistry } from './job.registry.js';
import { JobRunnerService } from './job-runner.service.js';
import { JobsController } from './jobs.controller.js';

/**
 * Global so that every source/pipeline module can inject JobRegistry and
 * register its own handler without JobsModule importing them (FR-B1).
 */
@Global()
@Module({
  controllers: [JobsController, HealthController],
  providers: [JobRegistry, AdvisoryLockService, JobRunnerService],
  exports: [JobRegistry, JobRunnerService, AdvisoryLockService],
})
export class JobsModule {}

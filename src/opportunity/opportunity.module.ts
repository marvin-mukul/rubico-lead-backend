import { Global, Module } from '@nestjs/common';
import { OpportunityConfigService } from './opportunity-config.service.js';
import { EvidenceService } from './evidence.service.js';
import { OpportunityTriggerService } from './trigger.service.js';

/**
 * Global because the trigger gate (pipeline), the evidence model (scoring)
 * and the classify prompt (llm) all read the same config, and none of them
 * should have to import a module to get at a constant.
 */
@Global()
@Module({
  providers: [OpportunityConfigService, OpportunityTriggerService, EvidenceService],
  exports: [OpportunityConfigService, OpportunityTriggerService, EvidenceService],
})
export class OpportunityModule {}

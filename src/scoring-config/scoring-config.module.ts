import { Global, Module } from '@nestjs/common';
import { ScoringConfigService } from './scoring-config.service.js';

@Global()
@Module({
  providers: [ScoringConfigService],
  exports: [ScoringConfigService],
})
export class ScoringConfigModule {}

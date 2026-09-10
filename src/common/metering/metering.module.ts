import { Global, Module } from '@nestjs/common';
import { ContactResolutionGuard } from './contact-resolution.guard.js';
import { ContactResolutionPolicy } from './contact-resolution.policy.js';
import { MeteredClient } from './metered-client.js';
import { SpendRepository } from './spend.repository.js';

@Global()
@Module({
  providers: [SpendRepository, MeteredClient, ContactResolutionPolicy, ContactResolutionGuard],
  exports: [SpendRepository, MeteredClient, ContactResolutionPolicy, ContactResolutionGuard],
})
export class MeteringModule {}

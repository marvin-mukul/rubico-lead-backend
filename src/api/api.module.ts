import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/index.js';
import { ContactsService, ManualContactResolver } from '../contacts/index.js';
import { CONTACT_RESOLVER } from '../contacts/contact-resolver.interface.js';
import { ScoringModule } from '../scoring/index.js';
import {
  AuthController,
  CompaniesController,
  ContactsController,
  FunnelController,
  LeadsController,
  MetaController,
  ScoringConfigController,
} from './api.controller.js';
import { FunnelService } from './funnel.service.js';
import { LeadsService } from './leads.service.js';

/** §8.3 — the `/api/*` surface. Session auth, no CORS, loopback-bound. */
@Module({
  imports: [ScoringModule, CompaniesModule],
  controllers: [
    AuthController,
    LeadsController,
    MetaController,
    CompaniesController,
    ContactsController,
    ScoringConfigController,
    FunnelController,
  ],
  providers: [
    LeadsService,
    ContactsService,
    ManualContactResolver,
    { provide: CONTACT_RESOLVER, useExisting: ManualContactResolver },
    FunnelService,
  ],
  exports: [LeadsService, ContactsService],
})
export class ApiModule {}

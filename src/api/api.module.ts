import { Module } from '@nestjs/common';
import { ContactsService, ManualContactResolver } from '../contacts/index.js';
import { CONTACT_RESOLVER } from '../contacts/contact-resolver.interface.js';
import { ScoringModule } from '../scoring/index.js';
import {
  AuthController,
  CompaniesController,
  ContactsController,
  LeadsController,
  ScoringConfigController,
} from './api.controller.js';
import { LeadsService } from './leads.service.js';

/** §8.3 — the `/api/*` surface. Session auth, no CORS, loopback-bound. */
@Module({
  imports: [ScoringModule],
  controllers: [
    AuthController,
    LeadsController,
    CompaniesController,
    ContactsController,
    ScoringConfigController,
  ],
  providers: [
    LeadsService,
    ContactsService,
    ManualContactResolver,
    { provide: CONTACT_RESOLVER, useExisting: ManualContactResolver },
  ],
  exports: [LeadsService, ContactsService],
})
export class ApiModule {}

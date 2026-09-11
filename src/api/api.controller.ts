import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentSession,
  SESSION_COOKIE,
  SessionAuth,
  SessionService,
  sessionCookieOptions,
  type SessionClaims,
} from '../common/auth/index.js';
import { AppConfigService } from '../common/config/app-config.service.js';
import {
  DECISION_REASON_CODES,
  DECISION_VALUES,
  EVENT_SIGNAL_TYPES,
  LEAD_BANDS,
  LEAD_SORTS,
  LEAD_STATUSES,
  SIGNAL_TYPES,
  SUPPRESSION_REASONS,
} from '../common/domain/index.js';
import { ContactResolutionGuard } from '../common/metering/index.js';
import { EVIDENCE_LEVELS } from '../opportunity/index.js';
import { PrismaService } from '../common/prisma/index.js';
import { ZodValidationPipe } from '../common/validation/index.js';
import { ContactsService } from '../contacts/index.js';
import { ScoringConfigService } from '../scoring-config/index.js';
import {
  companyDetailResponseSchema,
  contactListQuerySchema,
  contactListResponseSchema,
  contactSchema,
  createContactBodySchema,
  decisionBodySchema,
  decisionResponseSchema,
  leadDetailResponseSchema,
  leadListQuerySchema,
  leadListResponseSchema,
  loginBodySchema,
  loginResponseSchema,
  meResponseSchema,
  metaResponseSchema,
  scoringConfigPatchSchema,
  scoringConfigResponseSchema,
  type ContactListQuery,
  type CreateContactBody,
  type DecisionBody,
  type LeadListQuery,
  type LoginBody,
  type ScoringConfigPatch,
} from './dto.js';
import { LeadsService } from './leads.service.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, ApiZodResponse } from './openapi.js';

/**
 * §8.3 — the React dashboard SPA is the only client of these routes. It is
 * served from the same origin as this API (Vite proxy in development, reverse
 * proxy in production), which is why CORS stays disabled entirely (FR-B14)
 * and the server binds to loopback (FR-B15).
 */

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Sets the session as an httpOnly cookie and returns **no token**.
   *
   * `passthrough: true` so Nest still serialises the returned object — taking
   * `@Res()` without it silently makes the handler responsible for ending the
   * response, and the request hangs.
   *
   * The cookie's lifetime is derived from the token's own `exp` rather than
   * re-deriving the TTL here. Two independently-computed expiries drift, and
   * the failure mode is a browser that keeps sending a cookie the server has
   * already stopped honouring.
   */
  @Post('login')
  @HttpCode(200)
  @ApiZodBody('LoginBody', loginBodySchema)
  @ApiZodOk('LoginResponse', loginResponseSchema)
  async login(
    @Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = await this.sessions.login(body.email, body.password);
    const claims = this.sessions.verify(token);
    if (!claims) throw new UnauthorizedException();

    const maxAgeSeconds = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
    response.cookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(this.config.isProduction, maxAgeSeconds),
    );

    return { email: claims.sub, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  /**
   * Clears the cookie. The token itself is stateless and stays cryptographically
   * valid until it expires — this cannot revoke it, and does not pretend to.
   * Real revocation needs a denylist, which one shared Phase 0 credential does
   * not justify. What it does guarantee is that the browser stops presenting
   * it, which is the whole of what a logout button can honestly promise here.
   *
   * `clearCookie` must be given the same attributes the cookie was set with —
   * a mismatched `path` or `sameSite` leaves the original in place and logout
   * appears to do nothing.
   */
  @Post('logout')
  @HttpCode(204)
  @SessionAuth()
  logout(@Res({ passthrough: true }) response: Response): void {
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.config.isProduction));
  }

  @Get('me')
  @SessionAuth()
  @ApiZodOk('MeResponse', meResponseSchema)
  me(@CurrentSession() session: SessionClaims) {
    return {
      email: session.sub,
      issuedAt: new Date(session.iat * 1000).toISOString(),
      expiresAt: new Date(session.exp * 1000).toISOString(),
    };
  }
}

/**
 * The closed vocabularies the UI renders from (frontend FR-W30).
 *
 * Served straight from the domain constants, so this cannot drift from what
 * the validators accept: there is no second list to keep in step.
 */
@ApiTags('meta')
@Controller('api/meta')
@SessionAuth()
export class MetaController {
  @Get()
  @ApiZodOk('MetaResponse', metaResponseSchema)
  get() {
    return {
      bands: [...LEAD_BANDS],
      leadStatuses: [...LEAD_STATUSES],
      decisionValues: [...DECISION_VALUES],
      reasonCodes: [...DECISION_REASON_CODES],
      signalTypes: [...SIGNAL_TYPES],
      evidenceLevels: [...EVIDENCE_LEVELS],
      eventSignalTypes: [...EVENT_SIGNAL_TYPES],
      suppressionReasons: [...SUPPRESSION_REASONS],
      leadSorts: [...LEAD_SORTS],
    };
  }
}

@ApiTags('leads')
@Controller('api/leads')
@SessionAuth()
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @ApiZodQuery(leadListQuerySchema)
  @ApiZodOk('LeadListResponse', leadListResponseSchema)
  list(@Query(new ZodValidationPipe(leadListQuerySchema)) query: LeadListQuery) {
    return this.leads.list(query);
  }

  /** FR-B16: contributions come back with decay already applied. */
  @Get(':id')
  @ApiZodOk('LeadDetail', leadDetailResponseSchema)
  detail(@Param('id') id: string) {
    return this.leads.detail(id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @ApiZodBody('DecisionBody', decisionBodySchema)
  @ApiZodOk('DecisionResponse', decisionResponseSchema)
  decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionBodySchema)) body: DecisionBody,
    @CurrentSession() session: SessionClaims,
  ) {
    return this.leads.decide(id, session.sub, body);
  }
}

@ApiTags('companies')
@Controller('api/companies')
@SessionAuth()
export class CompaniesController {
  constructor(private readonly leads: LeadsService) {}

  @Get(':id')
  @ApiZodOk('CompanyDetail', companyDetailResponseSchema)
  detail(@Param('id') id: string) {
    return this.leads.company(id);
  }
}

@ApiTags('contacts')
@Controller('api/contacts')
@SessionAuth()
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiZodQuery(contactListQuerySchema)
  @ApiZodOk('ContactListResponse', contactListResponseSchema)
  list(@Query(new ZodValidationPipe(contactListQuerySchema)) query: ContactListQuery) {
    return this.contacts.listForLead(query.leadId);
  }

  /**
   * FR-C5 / A9: unreachable for a lead that is not approved. The guard
   * rejects before any work starts; ContactsService asserts the same rule
   * again, because a job can call the service without passing the guard.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(ContactResolutionGuard)
  @ApiZodBody('CreateContactBody', createContactBodySchema)
  @ApiZodResponse(201, 'Contact', contactSchema)
  create(@Body(new ZodValidationPipe(createContactBodySchema)) body: CreateContactBody) {
    return this.contacts.create(body);
  }
}

@ApiTags('scoring-config')
@Controller('api/scoring-config')
@SessionAuth()
export class ScoringConfigController {
  constructor(
    private readonly config: ScoringConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiZodOk('ScoringConfigResponse', scoringConfigResponseSchema)
  async get() {
    // Read the rows rather than the cache: `updatedAt` and `updatedBy` are
    // the audit trail for who last changed a weight, and the cache holds
    // only key -> value.
    const rows = await this.prisma.scoringConfig.findMany({ orderBy: { key: 'asc' } });
    return {
      config: rows.map((row) => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
      })),
    };
  }

  /** FR-SC3: weights and half-lives change with no deploy. */
  @Patch()
  @ApiZodBody('ScoringConfigPatch', scoringConfigPatchSchema)
  @ApiZodOk('ScoringConfigResponse', scoringConfigResponseSchema)
  async patch(
    @Body(new ZodValidationPipe(scoringConfigPatchSchema)) body: ScoringConfigPatch,
    @CurrentSession() session: SessionClaims,
  ) {
    for (const update of body.updates) {
      await this.config.set(update.key, update.value, session.sub);
    }
    return this.get();
  }
}

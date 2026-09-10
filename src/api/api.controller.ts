import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentSession, SessionAuth, SessionService, type SessionClaims } from '../common/auth/index.js';
import { ContactResolutionGuard } from '../common/metering/index.js';
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
 * §8.3 — the Next.js server layer is the only client of these routes. The
 * browser never calls them directly, which is why CORS is disabled entirely
 * (FR-B14) and the server binds to loopback (FR-B15).
 */

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly sessions: SessionService) {}

  @Post('login')
  @HttpCode(200)
  @ApiZodBody(loginBodySchema)
  @ApiZodOk(loginResponseSchema)
  async login(@Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody) {
    const token = await this.sessions.login(body.email, body.password);
    const claims = this.sessions.verify(token);
    if (!claims) throw new UnauthorizedException();
    return { token, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  /**
   * Tokens are stateless, so this cannot actually revoke one — it tells the
   * client to discard it, and the token stays valid until it expires. Real
   * revocation needs a denylist, which one shared Phase 0 credential does not
   * justify. Documented rather than faked.
   */
  @Post('logout')
  @HttpCode(204)
  @SessionAuth()
  logout(): void {}

  @Get('me')
  @SessionAuth()
  @ApiZodOk(meResponseSchema)
  me(@CurrentSession() session: SessionClaims) {
    return {
      email: session.sub,
      issuedAt: new Date(session.iat * 1000).toISOString(),
      expiresAt: new Date(session.exp * 1000).toISOString(),
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
  @ApiZodOk(leadListResponseSchema)
  list(@Query(new ZodValidationPipe(leadListQuerySchema)) query: LeadListQuery) {
    return this.leads.list(query);
  }

  /** FR-B16: contributions come back with decay already applied. */
  @Get(':id')
  @ApiZodOk(leadDetailResponseSchema)
  detail(@Param('id') id: string) {
    return this.leads.detail(id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @ApiZodBody(decisionBodySchema)
  @ApiZodOk(decisionResponseSchema)
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
  @ApiZodOk(companyDetailResponseSchema)
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
  @ApiZodOk(contactListResponseSchema)
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
  @ApiZodBody(createContactBodySchema)
  @ApiZodResponse(201, contactSchema)
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
  @ApiZodOk(scoringConfigResponseSchema)
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
  @ApiZodBody(scoringConfigPatchSchema)
  @ApiZodOk(scoringConfigResponseSchema)
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

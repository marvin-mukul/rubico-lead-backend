import { applyDecorators, createParamDecorator, ExecutionContext, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from './internal-token.guard.js';
import { SessionGuard } from './session.guard.js';
import type { AuthenticatedRequest, SessionClaims } from './session.types.js';

/** `/internal/*` — requires a valid X-Internal-Token (§8.1). */
export const InternalOnly = () => applyDecorators(UseGuards(InternalTokenGuard));

/** `/api/*` — requires a valid session cookie, or a Bearer token (§8.3). */
export const SessionAuth = () => applyDecorators(UseGuards(SessionGuard));

/** The verified session claims. Only meaningful behind `@SessionAuth()`. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionClaims | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().sessionClaims,
);

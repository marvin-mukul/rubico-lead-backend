import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from './session.service.js';
import type { AuthenticatedRequest } from './session.types.js';

/**
 * Guards `/api/*` — Next.js server → backend (§8.3).
 *
 * The browser never calls these routes directly; Next's server layer is the
 * only client, and it presents `Authorization: Bearer <session token>`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.header('authorization');

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const claims = this.sessions.verify(header.slice('Bearer '.length).trim());
    if (!claims) {
      throw new UnauthorizedException('Invalid or expired session token');
    }

    request.sessionClaims = claims;
    return true;
  }
}

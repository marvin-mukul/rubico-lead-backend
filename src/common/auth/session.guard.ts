import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SESSION_COOKIE } from './session.cookie.js';
import { SessionService } from './session.service.js';
import type { AuthenticatedRequest } from './session.types.js';

/**
 * Guards `/api/*` (§8.3).
 *
 * Two accepted transports, same token, same verification:
 *
 * 1. **The `rle_session` cookie** — the browser SPA. Required by frontend
 *    FR-W8/W-A9, which forbid the token being reachable from JavaScript at
 *    all. This is the primary transport; see `session.cookie.ts` for why
 *    `SameSite=Lax` is what makes a cookie session safe here.
 * 2. **`Authorization: Bearer`** — scripts, `curl`, and the e2e tests. Kept
 *    because it costs nothing: the guard verifies the identical HMAC either
 *    way, so accepting the header grants no capability the cookie does not
 *    already grant. Dropping it would only break tooling.
 *
 * The cookie is checked first so a stale `Authorization` header cannot
 * silently shadow a fresh login.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing session cookie or Bearer token');
    }

    const claims = this.sessions.verify(token);
    if (!claims) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    request.sessionClaims = claims;
    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    // `cookies` is populated by cookie-parser (registered in main.ts). Guarded
    // rather than assumed: a test that builds a bare request object, or a
    // future adapter without the middleware, must fail closed onto the header
    // path instead of throwing a TypeError that surfaces as a 500.
    const fromCookie = request.cookies?.[SESSION_COOKIE];
    if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;

    const header = request.header('authorization');
    if (header?.startsWith('Bearer ')) {
      const bearer = header.slice('Bearer '.length).trim();
      if (bearer.length > 0) return bearer;
    }

    return null;
  }
}

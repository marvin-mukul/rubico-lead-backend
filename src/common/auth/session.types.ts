import type { Request } from 'express';

/** Claims carried by a Phase 0 session token. */
export interface SessionClaims {
  /** Subject — the dashboard email. Single shared credential in Phase 0. */
  sub: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. */
  exp: number;
}

/** An Express request that has passed SessionGuard. */
export interface AuthenticatedRequest extends Request {
  sessionClaims?: SessionClaims;
}

/** An Express request that has passed IdempotencyInterceptor. */
export interface IdempotentRequest extends Request {
  idempotencyKey?: string;
}

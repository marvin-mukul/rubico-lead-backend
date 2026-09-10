import { Injectable, UnauthorizedException } from '@nestjs/common';
import { verify as argon2Verify } from '@node-rs/argon2';
import { createHmac, timingSafeEqual } from 'node:crypto';
// Leaf import, not the barrel: config/index.js re-exports config.module.ts,
// whose ConfigModule.forRoot({ validate }) runs at import time.
import { AppConfigService } from '../config/app-config.service.js';
import { safeCompare } from './safe-compare.js';
import type { SessionClaims } from './session.types.js';

/**
 * Phase 0 sessions (§8.3).
 *
 * A single shared credential, so the token is stateless: an HMAC-SHA256
 * signature over a compact JSON payload, keyed on SESSION_SECRET. Nothing is
 * stored server-side.
 *
 * Consequence, stated plainly: `POST /api/auth/logout` cannot actually revoke a
 * token — the client discards it and the token remains valid until it expires.
 * Adding real revocation means a denylist table, which Phase 0 does not need
 * with one shared credential. Revisit when multi-user auth arrives (§14).
 */

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

@Injectable()
export class SessionService {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Verifies the dashboard credentials and issues a token.
   * Throws UnauthorizedException on any failure, with no detail about which
   * half was wrong.
   */
  async login(email: string, password: string): Promise<string> {
    const { dashboardEmail, dashboardPasswordHash } = this.config.auth;

    // Compared constant-time and case-insensitively — email casing is not a secret,
    // but a fast-path mismatch would make user enumeration timeable.
    const emailMatches = safeCompare(
      email.trim().toLowerCase(),
      dashboardEmail.trim().toLowerCase(),
    );

    let passwordMatches = false;
    try {
      passwordMatches = await argon2Verify(dashboardPasswordHash, password);
    } catch {
      // A malformed DASHBOARD_PASSWORD_HASH must fail closed, not throw a 500.
      passwordMatches = false;
    }

    if (!emailMatches || !passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issue(dashboardEmail);
  }

  /** Signs a token for `subject`. */
  issue(subject: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: SessionClaims = { sub: subject, iat: now, exp: now + ttlSeconds };
    const payload = b64url(JSON.stringify(claims));
    const body = `${TOKEN_VERSION}.${payload}`;
    return `${body}.${this.sign(body)}`;
  }

  /** Returns the claims, or null for any malformed, forged or expired token. */
  verify(token: string): SessionClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [version, payload, signature] = parts;
    if (version !== TOKEN_VERSION) return null;

    const expected = this.sign(`${version}.${payload}`);
    const provided = Buffer.from(signature, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    if (provided.length !== expectedBytes.length) return null;
    if (!timingSafeEqual(provided, expectedBytes)) return null;

    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (typeof claims?.sub !== 'string' || typeof claims?.exp !== 'number') return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;

    return claims;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.config.auth.sessionSecret).update(body).digest('base64url');
  }
}

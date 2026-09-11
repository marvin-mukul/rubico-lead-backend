import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { Response } from 'express';
import { testConfig } from '../../../test/support/config.factory.js';
import { AuthController } from '../../api/api.controller.js';
import { SESSION_COOKIE, sessionCookieOptions } from './session.cookie.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';
import type { AuthenticatedRequest } from './session.types.js';

const EMAIL = 'dash@rubico.tech';
const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'session-secret-for-tests-0123456789abcdef';

/** Just enough of an Express request for the guard. */
const requestOf = (parts: {
  cookies?: Record<string, unknown>;
  authorization?: string;
}): AuthenticatedRequest =>
  ({
    ...(parts.cookies === undefined ? {} : { cookies: parts.cookies }),
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? parts.authorization : undefined,
  }) as unknown as AuthenticatedRequest;

const contextOf = (request: AuthenticatedRequest): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

/** Records what the controller did to the response. */
const responseSpy = () => {
  const set: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const cleared: { name: string; options: Record<string, unknown> }[] = [];
  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
      return response;
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, options });
      return response;
    },
  };
  return { response: response as unknown as Response, set, cleared };
};

/**
 * The session moved from `Authorization: Bearer` to an httpOnly cookie
 * because the dashboard became a browser SPA, and frontend FR-W8/W-A9 forbid
 * the token being reachable from JavaScript at all. These tests pin the three
 * things that decision rests on: the cookie is actually set and actually
 * httpOnly, the guard reads it, and the token is no longer echoed in a body
 * that JavaScript can read.
 */
describe('cookie sessions (frontend FR-W8 / W-A9)', () => {
  let sessions: SessionService;
  let guard: SessionGuard;
  let config: ReturnType<typeof testConfig>;

  beforeAll(async () => {
    config = testConfig({
      SESSION_SECRET: SECRET,
      DASHBOARD_EMAIL: EMAIL,
      DASHBOARD_PASSWORD_HASH: await hash(PASSWORD),
    });
    sessions = new SessionService(config);
    guard = new SessionGuard(sessions);
  });

  describe('SessionGuard', () => {
    it('authenticates from the session cookie', () => {
      const request = requestOf({ cookies: { [SESSION_COOKIE]: sessions.issue(EMAIL) } });
      expect(guard.canActivate(contextOf(request))).toBe(true);
      expect(request.sessionClaims?.sub).toBe(EMAIL);
    });

    it('still authenticates from a Bearer header, for scripts and tests', () => {
      const request = requestOf({ authorization: `Bearer ${sessions.issue(EMAIL)}` });
      expect(guard.canActivate(contextOf(request))).toBe(true);
      expect(request.sessionClaims?.sub).toBe(EMAIL);
    });

    // The cookie is the browser's transport and the browser cannot be made to
    // drop a stale Authorization header, so the fresher credential must win.
    it('prefers the cookie over a Bearer header', () => {
      const request = requestOf({
        cookies: { [SESSION_COOKIE]: sessions.issue(EMAIL) },
        authorization: 'Bearer not-a-real-token',
      });
      expect(guard.canActivate(contextOf(request))).toBe(true);
    });

    it('rejects a forged cookie exactly as it rejects a forged header', () => {
      expect(() =>
        guard.canActivate(contextOf(requestOf({ cookies: { [SESSION_COOKIE]: 'v1.x.y' } }))),
      ).toThrow(UnauthorizedException);
    });

    it('rejects an expired cookie', () => {
      const expired = sessions.issue(EMAIL, -1);
      expect(() =>
        guard.canActivate(contextOf(requestOf({ cookies: { [SESSION_COOKIE]: expired } }))),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a request carrying neither', () => {
      expect(() => guard.canActivate(contextOf(requestOf({})))).toThrow(UnauthorizedException);
    });

    // A request built without cookie-parser must fail closed, not throw a
    // TypeError that surfaces to the client as a 500.
    it('does not blow up when cookie-parser never ran', () => {
      expect(() => guard.canActivate(contextOf(requestOf({})))).toThrow(UnauthorizedException);
    });

    it('ignores an empty cookie rather than treating it as a token', () => {
      expect(() =>
        guard.canActivate(contextOf(requestOf({ cookies: { [SESSION_COOKIE]: '' } }))),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('AuthController', () => {
    const controller = () => new AuthController(sessions, config);

    it('sets an httpOnly, SameSite=Lax session cookie on login', async () => {
      const spy = responseSpy();
      await controller().login({ email: EMAIL, password: PASSWORD }, spy.response);

      expect(spy.set).toHaveLength(1);
      const cookie = spy.set[0]!;
      expect(cookie.name).toBe(SESSION_COOKIE);
      expect(cookie.options.httpOnly).toBe(true);
      expect(cookie.options.sameSite).toBe('lax');
      expect(cookie.options.path).toBe('/');
      // The cookie must carry a token the guard will actually accept.
      expect(sessions.verify(cookie.value)?.sub).toBe(EMAIL);
    });

    // W-A9: if the body carried the token, the rule "no token in JS" would
    // hold only for as long as nobody stored what the response handed them.
    it('returns no token in the response body', async () => {
      const spy = responseSpy();
      const body = await controller().login({ email: EMAIL, password: PASSWORD }, spy.response);

      expect(JSON.stringify(body)).not.toContain(spy.set[0]!.value);
      expect(body).not.toHaveProperty('token');
      expect(body.email).toBe(EMAIL);
    });

    it('gives the cookie the same lifetime as the token it carries', async () => {
      const spy = responseSpy();
      const body = await controller().login({ email: EMAIL, password: PASSWORD }, spy.response);

      const maxAgeMs = spy.set[0]!.options.maxAge as number;
      const cookieExpiry = Date.now() + maxAgeMs;
      const tokenExpiry = new Date(body.expiresAt).getTime();
      // Within a second — they are computed from the same claims, so any
      // real drift means the two expiries were derived independently.
      expect(Math.abs(cookieExpiry - tokenExpiry)).toBeLessThan(1000);
    });

    it('rejects bad credentials without setting anything', async () => {
      const spy = responseSpy();
      await expect(
        controller().login({ email: EMAIL, password: 'wrong' }, spy.response),
      ).rejects.toThrow(UnauthorizedException);
      expect(spy.set).toHaveLength(0);
    });

    // clearCookie only matches if the attributes match what was set —
    // otherwise logout silently leaves the session in place.
    it('clears the cookie on logout with the attributes it was set with', () => {
      const spy = responseSpy();
      controller().logout(spy.response);

      expect(spy.cleared).toHaveLength(1);
      expect(spy.cleared[0]!.name).toBe(SESSION_COOKIE);
      expect(spy.cleared[0]!.options.path).toBe('/');
      expect(spy.cleared[0]!.options.sameSite).toBe('lax');
      expect(spy.cleared[0]!.options.httpOnly).toBe(true);
    });
  });

  describe('sessionCookieOptions', () => {
    // Dev runs plain http through the Vite proxy; a Secure cookie would be
    // dropped silently and every request after login would 401.
    it('is Secure only in production', () => {
      expect(sessionCookieOptions(true).secure).toBe(true);
      expect(sessionCookieOptions(false).secure).toBe(false);
    });

    it('omits maxAge entirely when none is given, so clearCookie matches', () => {
      expect(sessionCookieOptions(false)).not.toHaveProperty('maxAge');
    });
  });
});

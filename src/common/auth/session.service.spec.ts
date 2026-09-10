import { UnauthorizedException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { testConfig } from '../../../test/support/config.factory.js';
import { SessionService } from './session.service.js';

const EMAIL = 'dash@rubico.tech';
const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'session-secret-for-tests-0123456789abcdef';

describe('SessionService (§8.3)', () => {
  let sessions: SessionService;

  beforeAll(async () => {
    sessions = new SessionService(
      testConfig({
        SESSION_SECRET: SECRET,
        DASHBOARD_EMAIL: EMAIL,
        DASHBOARD_PASSWORD_HASH: await hash(PASSWORD),
      }),
    );
  });

  describe('login', () => {
    it('issues a verifiable token for correct credentials', async () => {
      const token = await sessions.login(EMAIL, PASSWORD);
      expect(sessions.verify(token)?.sub).toBe(EMAIL);
    });

    it('accepts a differently-cased email', async () => {
      const token = await sessions.login(EMAIL.toUpperCase(), PASSWORD);
      expect(sessions.verify(token)).not.toBeNull();
    });

    it('rejects a wrong password', async () => {
      await expect(sessions.login(EMAIL, 'wrong')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a wrong email', async () => {
      await expect(sessions.login('someone@else.com', PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('fails closed on a malformed password hash rather than throwing a 500', async () => {
      const broken = new SessionService(
        testConfig({
          SESSION_SECRET: SECRET,
          DASHBOARD_EMAIL: EMAIL,
          DASHBOARD_PASSWORD_HASH: 'not-an-argon2-hash',
        }),
      );
      await expect(broken.login(EMAIL, PASSWORD)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('verify', () => {
    it('rejects a tampered payload', () => {
      const [version, , signature] = sessions.issue(EMAIL).split('.');
      const forged = Buffer.from(
        JSON.stringify({ sub: 'attacker@evil.com', iat: 0, exp: 9999999999 }),
      ).toString('base64url');
      expect(sessions.verify(`${version}.${forged}.${signature}`)).toBeNull();
    });

    it('rejects a tampered signature', () => {
      const [version, payload] = sessions.issue(EMAIL).split('.');
      expect(sessions.verify(`${version}.${payload}.AAAA`)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
      const other = new SessionService(testConfig({ SESSION_SECRET: 'a-completely-different-secret-value' }));
      expect(sessions.verify(other.issue(EMAIL))).toBeNull();
    });

    it('rejects an expired token', () => {
      expect(sessions.verify(sessions.issue(EMAIL, -1))).toBeNull();
    });

    it('rejects malformed input', () => {
      for (const bad of ['', 'x', 'a.b', 'a.b.c.d', 'v2.abc.def']) {
        expect(sessions.verify(bad)).toBeNull();
      }
    });
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { contextWithHeaders } from '../../../test/support/execution-context.js';
import { testConfig } from '../../../test/support/config.factory.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { safeCompare } from './safe-compare.js';

const TOKEN = 'internal-token-for-tests-0123456789abcdef';

describe('InternalTokenGuard (§8.1)', () => {
  const guard = new InternalTokenGuard(testConfig({ INTERNAL_API_TOKEN: TOKEN }));

  it('accepts a matching X-Internal-Token', () => {
    expect(guard.canActivate(contextWithHeaders({ 'X-Internal-Token': TOKEN }))).toBe(true);
  });

  it('is case-insensitive about the header name', () => {
    expect(guard.canActivate(contextWithHeaders({ 'x-internal-token': TOKEN }))).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong token', () => {
    expect(() => guard.canActivate(contextWithHeaders({ 'X-Internal-Token': 'nope' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token that is a prefix of the real one', () => {
    expect(() =>
      guard.canActivate(contextWithHeaders({ 'X-Internal-Token': TOKEN.slice(0, -1) })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects an empty token', () => {
    expect(() => guard.canActivate(contextWithHeaders({ 'X-Internal-Token': '' }))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('safeCompare', () => {
  it('matches identical strings', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(safeCompare('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(safeCompare('abc', 'abcdef')).toBe(false);
    expect(safeCompare('', 'a')).toBe(false);
  });
});

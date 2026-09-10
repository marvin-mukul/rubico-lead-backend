import { BadRequestException } from '@nestjs/common';
import { contextWithHeaders, noopHandler, requestOf } from '../../../test/support/execution-context.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

const VALID = 'n8n-run-2026-09-10T04:00:00Z';

describe('IdempotencyInterceptor (FR-B7)', () => {
  const interceptor = new IdempotencyInterceptor();

  it('attaches a valid key to the request', () => {
    const context = contextWithHeaders({ 'X-Idempotency-Key': VALID });
    interceptor.intercept(context, noopHandler);
    expect(requestOf(context).idempotencyKey).toBe(VALID);
  });

  it('rejects a missing header', () => {
    expect(() => interceptor.intercept(contextWithHeaders({}), noopHandler)).toThrow(
      BadRequestException,
    );
  });

  it('rejects keys that are too short, too long, or contain whitespace', () => {
    for (const bad of ['', 'short', 'has space', 'tab\tchar', 'x'.repeat(256)]) {
      expect(() =>
        interceptor.intercept(contextWithHeaders({ 'X-Idempotency-Key': bad }), noopHandler),
      ).toThrow(BadRequestException);
    }
  });
});

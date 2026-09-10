import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  UseInterceptors,
} from '@nestjs/common';
import type { IdempotentRequest } from '../auth/session.types.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/** Requires and validates `X-Idempotency-Key` on the route (FR-B7). */
export const RequireIdempotencyKey = () =>
  applyDecorators(UseInterceptors(IdempotencyInterceptor));

/** The validated key. Only meaningful behind `@RequireIdempotencyKey()`. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<IdempotentRequest>().idempotencyKey,
);

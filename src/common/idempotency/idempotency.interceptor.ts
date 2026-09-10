import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { IdempotentRequest } from '../auth/session.types.js';

/** Printable ASCII, no whitespace or control characters. */
const KEY_PATTERN = /^[\x21-\x7e]{8,255}$/;

export const IDEMPOTENCY_HEADER = 'x-idempotency-key';

/**
 * FR-B7: the `X-Idempotency-Key` header is required on job triggers and on
 * first-party ingest. n8n retries on failure, and re-ingesting must not
 * duplicate or re-spend.
 *
 * This interceptor only validates the header and attaches it to the request.
 * It deliberately does **not** look the key up and short-circuit: two
 * concurrent n8n retries would both miss that read and both proceed. The
 * actual guarantee is the unique constraint on `job_runs.idempotency_key`,
 * enforced atomically by IdempotencyService.claim().
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const key = request.header(IDEMPOTENCY_HEADER);

    if (!key) {
      throw new BadRequestException(`Missing ${IDEMPOTENCY_HEADER} header`);
    }
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException(
        `${IDEMPOTENCY_HEADER} must be 8-255 printable, non-whitespace characters`,
      );
    }

    request.idempotencyKey = key;
    return next.handle();
  }
}

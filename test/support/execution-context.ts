import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

/** A minimal ExecutionContext carrying just the given request headers. */
export function contextWithHeaders(headers: Record<string, string>): ExecutionContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const request = {
    header: (name: string): string | undefined => lower[name.toLowerCase()],
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** The request object a contextWithHeaders() context exposes. */
export function requestOf(context: ExecutionContext): Record<string, unknown> {
  return context.switchToHttp().getRequest();
}

export const noopHandler: CallHandler = { handle: () => of(null) };

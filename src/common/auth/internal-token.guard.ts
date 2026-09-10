import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
// Leaf import, not the barrel: config/index.js re-exports config.module.ts,
// whose ConfigModule.forRoot({ validate }) runs at import time.
import { AppConfigService } from '../config/app-config.service.js';
import { safeCompare } from './safe-compare.js';

/**
 * Guards `/internal/*` — n8n → backend (§8.1).
 *
 * Auth is a single `X-Internal-Token` header matching INTERNAL_API_TOKEN,
 * compared in constant time.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-internal-token');

    if (!provided) {
      throw new UnauthorizedException('Missing X-Internal-Token header');
    }
    if (!safeCompare(provided, this.config.auth.internalApiToken)) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}

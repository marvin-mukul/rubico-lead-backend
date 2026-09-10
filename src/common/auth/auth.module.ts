import { Global, Module } from '@nestjs/common';
import { InternalTokenGuard } from './internal-token.guard.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * Global so `@InternalOnly()` and `@SessionAuth()` work in any module without
 * that module importing anything.
 */
@Global()
@Module({
  providers: [SessionService, InternalTokenGuard, SessionGuard],
  exports: [SessionService, InternalTokenGuard, SessionGuard],
})
export class AuthModule {}

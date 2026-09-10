import { Global, Module } from '@nestjs/common';
import { N8nNotifier } from './n8n.notifier.js';
import { NOTIFIER } from './notifier.interface.js';

/**
 * The Notifier seam (§4). Swapping n8n for anything else is one line here
 * plus a new provider class — no call site changes (FR-B1).
 */
@Global()
@Module({
  providers: [N8nNotifier, { provide: NOTIFIER, useExisting: N8nNotifier }],
  exports: [NOTIFIER],
})
export class NotificationsModule {}

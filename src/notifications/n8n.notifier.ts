import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service.js';
import type { NotificationEvent, Notifier } from './notifier.interface.js';

const TIMEOUT_MS = 5_000;

/**
 * Pushes urgent, unscheduled events to n8n (§8.2). Everything scheduled is
 * pulled instead — see FR-B12 and the digest endpoint.
 *
 * FR-B13: delivery failure must never fail a job. Every path here logs and
 * returns; nothing throws. The health endpoint exposes MTD spend as the
 * fallback signal when alerts are not arriving.
 */
@Injectable()
export class N8nNotifier implements Notifier {
  private readonly logger = new Logger(N8nNotifier.name);

  constructor(private readonly config: AppConfigService) {}

  async send(event: NotificationEvent): Promise<void> {
    const payload = {
      ...event,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    };

    // One retry only. §14 puts rate-limit sophistication out of scope, and a
    // notification that needs more than two attempts is not the thing keeping
    // this system honest — the health endpoint is.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(this.config.n8n.alertWebhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-token': this.config.n8n.webhookToken,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (response.ok) {
          this.logger.log(`Sent ${payload.type} (${payload.severity})`);
          return;
        }
        this.logger.warn(
          `n8n webhook returned ${response.status} for ${payload.type} (attempt ${attempt}/2)`,
        );
      } catch (error) {
        this.logger.warn(
          `n8n webhook failed for ${payload.type} (attempt ${attempt}/2): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // FR-B13: swallowed deliberately. Log loudly, never propagate.
    this.logger.error(
      `Notification undelivered after 2 attempts: ${payload.type} — ${payload.message}`,
    );
  }
}

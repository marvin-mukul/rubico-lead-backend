import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { testConfig } from '../../test/support/config.factory.js';
import { N8nNotifier } from './n8n.notifier.js';
import type { NotificationEvent } from './notifier.interface.js';

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** A throwaway webhook receiver standing in for n8n. */
async function listen(
  handler: (received: Received) => { status: number },
): Promise<{ url: string; server: Server; calls: Received[] }> {
  const calls: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const received = { headers: req.headers, body: JSON.parse(raw || '{}') };
      calls.push(received);
      res.writeHead(handler(received).status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/webhook/alerts`, server, calls };
}

const EVENT: NotificationEvent = {
  severity: 'critical',
  type: 'cost.cap_breached',
  message: 'gemini MTD spend $25.04 exceeded cap $25.00',
  context: { provider: 'gemini', mtdUsd: 25.04, capUsd: 25.0 },
};

describe('N8nNotifier (§8.2)', () => {
  it('POSTs the §8.2 payload with the webhook token header', async () => {
    const { url, server, calls } = await listen(() => ({ status: 200 }));
    try {
      const notifier = new N8nNotifier(
        testConfig({ N8N_ALERT_WEBHOOK_URL: url, N8N_WEBHOOK_TOKEN: 'secret-token' }),
      );
      await notifier.send(EVENT);

      expect(calls).toHaveLength(1);
      expect(calls[0].headers['x-webhook-token']).toBe('secret-token');
      expect(calls[0].body).toMatchObject({
        severity: 'critical',
        type: 'cost.cap_breached',
        message: EVENT.message,
        context: { provider: 'gemini', mtdUsd: 25.04, capUsd: 25 },
      });
      // occurredAt is filled in when the caller omits it.
      expect(
        new Date((calls[0].body as { occurredAt: string }).occurredAt).getTime(),
      ).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('preserves an explicit occurredAt', async () => {
    const { url, server, calls } = await listen(() => ({ status: 200 }));
    try {
      const notifier = new N8nNotifier(testConfig({ N8N_ALERT_WEBHOOK_URL: url }));
      await notifier.send({ ...EVENT, occurredAt: '2026-09-10T04:12:00.000Z' });
      expect((calls[0].body as { occurredAt: string }).occurredAt).toBe(
        '2026-09-10T04:12:00.000Z',
      );
    } finally {
      server.close();
    }
  });

  // FR-B13 — the reason this module exists in the shape it does.
  it('does not throw when the webhook is unreachable', async () => {
    const notifier = new N8nNotifier(
      // Port 1 is reserved and nothing listens on it.
      testConfig({ N8N_ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/webhook' }),
    );
    await expect(notifier.send(EVENT)).resolves.toBeUndefined();
  });

  it('does not throw when the webhook returns 500, and retries once', async () => {
    const { url, server, calls } = await listen(() => ({ status: 500 }));
    try {
      const notifier = new N8nNotifier(testConfig({ N8N_ALERT_WEBHOOK_URL: url }));
      await expect(notifier.send(EVENT)).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('stops after the first success', async () => {
    const { url, server, calls } = await listen(() => ({ status: 204 }));
    try {
      const notifier = new N8nNotifier(testConfig({ N8N_ALERT_WEBHOOK_URL: url }));
      await notifier.send(EVENT);
      expect(calls).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});

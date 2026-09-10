import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SourceHttpClient, SourceHttpError } from './source-http.client.js';

async function serve(
  handler: (path: string, attempt: number) => { status: number; body?: string },
): Promise<{ base: string; server: Server; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const { status, body } = handler(req.url ?? '/', hits);
    res.writeHead(status, { 'content-type': 'application/json' }).end(body ?? '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    hits: () => hits,
  };
}

describe('SourceHttpClient', () => {
  const http = new SourceHttpClient();

  it('returns the body on success', async () => {
    const s = await serve(() => ({ status: 200, body: '{"ok":true}' }));
    try {
      expect(await http.getJson({ url: `${s.base}/x`, minIntervalMs: 0 })).toEqual({ ok: true });
    } finally {
      s.server.close();
    }
  });

  it('returns null for 404 when acceptMissing is set', async () => {
    const s = await serve(() => ({ status: 404 }));
    try {
      expect(await http.getText({ url: `${s.base}/x`, minIntervalMs: 0, acceptMissing: true })).toBeNull();
    } finally {
      s.server.close();
    }
  });

  // SEC answers 403 for a daily-index file that does not exist.
  it('returns null for an opted-in status via treatAsMissing', async () => {
    const s = await serve(() => ({ status: 403 }));
    try {
      expect(
        await http.getText({ url: `${s.base}/x`, minIntervalMs: 0, treatAsMissing: [403] }),
      ).toBeNull();
    } finally {
      s.server.close();
    }
  });

  it('throws on a status that is neither ok nor opted in', async () => {
    const s = await serve(() => ({ status: 403 }));
    try {
      await expect(http.getText({ url: `${s.base}/x`, minIntervalMs: 0 })).rejects.toBeInstanceOf(
        SourceHttpError,
      );
    } finally {
      s.server.close();
    }
  });

  it('retries a 429 and succeeds', async () => {
    const s = await serve((_p, attempt) =>
      attempt === 1 ? { status: 429 } : { status: 200, body: '{"ok":true}' },
    );
    try {
      expect(await http.getJson({ url: `${s.base}/x`, minIntervalMs: 0 })).toEqual({ ok: true });
      expect(s.hits()).toBe(2);
    } finally {
      s.server.close();
    }
  });

  it('gives up after the retry budget and reports the status', async () => {
    const s = await serve(() => ({ status: 503 }));
    try {
      await expect(
        http.getJson({ url: `${s.base}/x`, minIntervalMs: 0 }),
      ).rejects.toThrow(/503/);
      expect(s.hits()).toBe(3);
    } finally {
      s.server.close();
    }
  });

  it('does not retry a 400', async () => {
    const s = await serve(() => ({ status: 400 }));
    try {
      await expect(http.getJson({ url: `${s.base}/x`, minIntervalMs: 0 })).rejects.toThrow(/400/);
      expect(s.hits()).toBe(1);
    } finally {
      s.server.close();
    }
  });
});

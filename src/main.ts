import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { AppConfigService } from './common/config/index.js';
import { buildOpenApiDocument } from './openapi.factory.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  // FR-B14: CORS stays disabled. The browser DOES call this API now — the
  // React dashboard is a SPA — but it only ever sees one origin: Vite proxies
  // `/api` in development, and a reverse proxy serves the built SPA and this
  // API from the same origin in production. Same-origin needs no CORS headers,
  // and adding `enableCors()` with `credentials: true` would be the one change
  // that turns the SameSite=Lax session cookie into a CSRF liability.
  // Do not add app.enableCors().

  // Populates `req.cookies`, which SessionGuard reads (frontend FR-W8).
  app.use(cookieParser());

  app.enableShutdownHooks();

  // FR-B17: the spec is served in non-production only. In production the
  // contract is the committed openapi.json, not a live endpoint.
  if (!config.isProduction) {
    const document = buildOpenApiDocument(app);
    app.getHttpAdapter().get('/openapi.json', (_req: unknown, res: { json: (b: unknown) => void }) =>
      res.json(document),
    );
    Logger.log('OpenAPI served at /openapi.json (non-production only)', 'Bootstrap');
  }

  // FR-B15: bind to the loopback interface in production when Next and n8n are
  // co-hosted. If n8n moves to another host, bind to the private interface and
  // add an IP allowlist.
  await app.listen(config.port, config.bindAddress);

  Logger.log(
    `Listening on ${config.bindAddress}:${config.port} [${config.nodeEnv}]`,
    'Bootstrap',
  );
}

await bootstrap();

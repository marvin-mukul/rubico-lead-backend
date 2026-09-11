import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { registeredSchemas } from './api/openapi.js';
import { SESSION_COOKIE } from './common/auth/session.cookie.js';

/**
 * FR-B17/FR-B18: the frontend generates its types from this document. It is
 * served at `/openapi.json` in non-production and written to `openapi.json`
 * at the repo root by `npm run openapi:export`.
 *
 * Only `/api/*` is documented. `/internal/*` is n8n's surface and is
 * described in the n8n doc; publishing it here would invite the frontend to
 * call it.
 */
export function buildOpenApiDocument(app: INestApplication): Record<string, unknown> {
  const config = new DocumentBuilder()
    .setTitle('Rubico Lead Engine API')
    .setDescription(
      'Consumed by the React dashboard SPA, served same-origin behind a proxy. ' +
        'Authenticated by an httpOnly session cookie (§8.3).',
    )
    .setVersion('0.1.0')
    // Both transports the SessionGuard accepts. The cookie is what the
    // browser SPA uses; the bearer scheme stays for scripts and tests.
    .addCookieAuth(SESSION_COOKIE, { type: 'apiKey', in: 'cookie' }, 'session')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'sessionBearer')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // `/internal/*` is deliberately excluded — see above.
    include: [],
    deepScanRoutes: true,
  }) as unknown as {
    paths: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };

  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) => path.startsWith('/api/')),
  );

  // The Zod-derived components (see api/openapi.ts). Without these the
  // document's `$ref`s dangle and `components.schemas` is empty, which is
  // what makes openapi-typescript emit `schemas: never` and leaves the
  // frontend with no name for any response.
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...registeredSchemas() },
  };

  return document as unknown as Record<string, unknown>;
}

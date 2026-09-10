import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

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
      'Consumed by the Next.js server layer only. The browser never calls these ' +
        'routes directly (§8.3).',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'session')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // `/internal/*` is deliberately excluded — see above.
    include: [],
    deepScanRoutes: true,
  }) as unknown as { paths: Record<string, unknown> };

  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) => path.startsWith('/api/')),
  );

  return document as unknown as Record<string, unknown>;
}

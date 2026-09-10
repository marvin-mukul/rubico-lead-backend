import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { buildOpenApiDocument } from './openapi.factory.js';

/**
 * FR-B17: writes `openapi.json` to the repo root. CI runs this on every merge
 * to main; A10 checks the committed file is current.
 *
 * Deliberately compiled rather than run through tsx: Nest's DI needs
 * `emitDecoratorMetadata`, which tsx does not emit, so a tsx run fails to
 * resolve constructor parameters. `npm run openapi:export` builds first.
 */
const app = await NestFactory.create(AppModule, { logger: ['error'] });
await app.init();

const document = buildOpenApiDocument(app);
writeFileSync('openapi.json', `${JSON.stringify(document, null, 2)}\n`);

const paths = Object.keys((document as { paths: Record<string, unknown> }).paths).sort();
console.log(`Wrote openapi.json with ${paths.length} /api/* path(s):`);
for (const path of paths) console.log(`  ${path}`);

await app.close();

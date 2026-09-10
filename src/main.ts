import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { AppConfigService } from './common/config/index.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  // FR-B14: CORS is disabled entirely. The browser never calls this API —
  // Next.js's server layer is the only client. Do not add app.enableCors().

  app.enableShutdownHooks();

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

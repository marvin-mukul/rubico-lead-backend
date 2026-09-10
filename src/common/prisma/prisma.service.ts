import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
// Leaf import, not the barrel: config/index.js re-exports config.module.ts,
// whose ConfigModule.forRoot({ validate }) runs at import time.
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Prisma 7 requires a driver adapter — the connection URL no longer lives in
 * schema.prisma. The URL comes from AppConfigService so this stays the only
 * place that knows how the database is reached.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap liveness probe for GET /internal/health (§8.1). */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { getValidatedEnv, validateEnv } from './env.schema.js';
import { PriceTable } from './price-table.js';

/**
 * Validates the whole environment at boot with Zod and fails fast on anything
 * missing (requirement.md §10). Global so no other module has to import it.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      // Throws during module initialisation, which aborts the boot.
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: AppConfigService,
      // ConfigService is injected purely to force ConfigModule (and therefore
      // `validate`) to initialise before this factory runs.
      inject: [ConfigService],
      useFactory: (): AppConfigService => {
        const env = getValidatedEnv();
        return new AppConfigService(env, PriceTable.fromFile(env.PRICE_TABLE_PATH));
      },
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}

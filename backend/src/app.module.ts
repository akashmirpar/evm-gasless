import KeyvRedis from '@keyv/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AllExceptionsFilter } from './common/filters/all_exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { loadConfig } from './config';
import { RequestContextInterceptor } from './core/context/context.interceptor';
import { ChainConfigModule } from './core/chain_config/chain_config.module';
import { AppDataSource, buildDataSourceOptions } from './core/database/data-source';
import { HealthModule } from './core/health/health.module';
import { RpcModule } from './core/rpc/rpc.module';
import { TokenMetadataModule } from './core/token_metadata/token_metadata.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { EvmModule } from './modules/evm/evm.module';
import { SolanaModule } from './modules/solana/solana.module';
import { RangoModule } from './modules/rango/rango.module';
import { RelayerModule } from './modules/relayer/relayer.module';
import { RelayerSolanaModule } from './modules/relayer-solana/relayer-solana.module';

@Module({
  imports: [
    // Single source of truth: the merged map (src/config) is loaded here and
    // consumed everywhere via ConfigService. `ignoreEnvFile` disables
    // @nestjs/config's own .env parsing — loadConfig owns the full precedence
    // (yaml defaults < process.env < secret file), so process.env overrides
    // still apply for declared keys.
    ConfigModule.forRoot({
      load: [loadConfig],
      isGlobal: true,
      ignoreEnvFile: true,
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => buildDataSourceOptions(),
      dataSourceFactory: async () => {
        if (!AppDataSource.isInitialized) {
          await AppDataSource.initialize();
        }
        return AppDataSource;
      },
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('REDIS_HOST') ?? '127.0.0.1';
        const port = Number(config.get<string>('REDIS_PORT') ?? 6379);
        // Optional ACL username: embed it in the URL (redis://user:pass@host) so we
        // authenticate as the per-service ACL user. Unset => default user (unchanged).
        const username = config.get<string>('REDIS_USERNAME') ?? '';
        const password = config.get<string>('REDIS_PASSWORD');
        const ttlSeconds = Number(config.get<string>('REDIS_DEFAULT_TTL_SECONDS') ?? 300);
        const auth = password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        const url = `redis://${auth}${host}:${port}`;
        const keyvRedis = new KeyvRedis({
          url,
          socket: { connectTimeout: 1_500, reconnectStrategy: (retries: number) => Math.min(retries * 200, 2_000) },
        });
        return { stores: [keyvRedis], ttl: ttlSeconds * 1_000 };
      },
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ChainConfigModule,
    RpcModule,
    TokenMetadataModule,
    HealthModule,
    AuthModule,
    AdminModule,
    RangoModule,
    RelayerModule,
    EvmModule,
    SolanaModule,
    RelayerSolanaModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: () => new ValidationPipe({ whitelist: true, transform: true }) },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}

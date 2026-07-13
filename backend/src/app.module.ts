import KeyvRedis from '@keyv/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AllExceptionsFilter } from './common/filters/all_exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
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
      useFactory: () => {
        const host = process.env.REDIS_HOST ?? '127.0.0.1';
        const port = Number(process.env.REDIS_PORT ?? 6379);
        // Optional ACL username: embed it in the URL (redis://user:pass@host) so we
        // authenticate as the per-service ACL user. Unset => default user (unchanged).
        const username = process.env.REDIS_USERNAME ?? '';
        const password = process.env.REDIS_PASSWORD;
        const ttlSeconds = Number(process.env.REDIS_DEFAULT_TTL_SECONDS ?? 300);
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

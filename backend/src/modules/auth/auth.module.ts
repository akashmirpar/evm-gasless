import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';

import { ApiKeyEntity } from './domain/entity/api_key.entity';
import { ApiKeyGuard } from './interface/guards/api_key.guard';
import { AuthService } from './services/auth.service';
import { RATE_LIMIT_REDIS, RateLimiterService } from './services/rate_limiter.service';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKeyEntity])],
  providers: [
    AuthService,
    ApiKeyGuard,
    RateLimiterService,
    {
      provide: RATE_LIMIT_REDIS,
      useFactory: () => {
        const logger = new Logger('RateLimiterRedis');
        const client = new Redis({
          host: process.env.REDIS_HOST ?? '127.0.0.1',
          port: Number(process.env.REDIS_PORT ?? 6379),
          password: process.env.REDIS_PASSWORD || undefined,
          connectTimeout: 1_500,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: false,
        });
        client.on('error', (err) => logger.warn(`rate limiter redis: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [AuthService, ApiKeyGuard, RateLimiterService, TypeOrmModule],
})
export class AuthModule {}

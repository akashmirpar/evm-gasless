import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import supertest from 'supertest';

import { AppModule } from 'src/app.module';
import { AppDataSource } from 'src/core/database/data-source';
import { ApiKeyEntity } from 'src/modules/auth/domain/entity/api_key.entity';
import { RangoClient } from 'src/modules/rango/rango.client';
import { RpcService } from 'src/core/rpc/rpc.service';
import { TokenMetadataService } from 'src/core/token_metadata/token_metadata.service';

// Arbitrum mainFeeToken (accepted) from the config.yaml chain registry.
const ARB = 42161;
const USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const USER = '0x1111111111111111111111111111111111111111';

/**
 * End-to-end over the live estimate path with the new fee model wired in:
 * HTTP → ApiKeyGuard → EvmController → EvmService → FeeEstimatorService →
 * FeePolicyService → PricingService → real Redis (populated by the real
 * TokenPriceRefreshJob using a stubbed Rango /meta). Rango, RPC, and token
 * metadata are stubbed so no external network is needed; everything else is
 * the real DI graph.
 */
describe('fee-model e2e (fixed mode, real Redis + pricing)', () => {
  let app: INestApplication;
  let http: supertest.Agent;
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  let apiKey: string;

  beforeAll(async () => {
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: 'gasless', POSTGRES_PASSWORD: 'gasless', POSTGRES_DB: 'gasless' })
      .withExposedPorts(5432)
      .withCommand(['postgres', '-c', 'fsync=off'])
      .start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    process.env.DATABASE_POSTGRES_HOST = postgres.getHost();
    process.env.DATABASE_POSTGRES_PORT = String(postgres.getMappedPort(5432));
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getMappedPort(6379));
    process.env.GASLESS_ACCEPTED_FEE_TOKENS = `${ARB}:${USDT}`;
    process.env.GASLESS_FEE_MODE = 'fixed';
    process.env.GASLESS_FEE_PROFIT = `${ARB}:${USDT}:0.5`;
    process.env.GASLESS_NO_LOSS_CHECK = 'true';
    process.env.GASLESS_PRIORITY_HEADROOM_BPS = '3000';

    const rangoStub: Partial<RangoClient> = {
      meta: async () => [
        { chainName: 'ARBITRUM', address: null, symbol: 'ETH', decimals: 18, usdPrice: 3000 },
        { chainName: 'ARBITRUM', address: USDT, symbol: 'USDT', decimals: 6, usdPrice: 1 },
      ],
      quote: async () => { throw new Error('quote should not be called in fixed accepted path'); },
      swap: async () => { throw new Error('swap should not be called'); },
    };
    const rpcStub: Partial<RpcService> = {
      withChain: (async (_chainId: number, fn: (c: unknown) => Promise<unknown>) =>
        fn({
          suggestGas: async () => ({ effectiveGasPrice: () => 20_000_000n }),
          call: async () => ({ gasEstimate: 100_000n }),
        })) as never,
    };
    const tokenMetaStub: Partial<TokenMetadataService> = {
      getDecimals: async () => 6,
      getSymbolBestEffort: async () => 'USDT',
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_PIPE)
      .useFactory({ factory: () => new ValidationPipe({ whitelist: true, transform: true }) })
      .overrideProvider(RangoClient)
      .useValue(rangoStub)
      .overrideProvider(RpcService)
      .useValue(rpcStub)
      .overrideProvider(TokenMetadataService)
      .useValue(tokenMetaStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = supertest(app.getHttpServer());

    // Seed an integrator key (the /gasless surface is guarded).
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    apiKey = randomUUID();
    await AppDataSource.getRepository(ApiKeyEntity).save({ key: apiKey, clientName: 'fee-e2e', rateLimitRps: 0, isActive: true });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  const body = {
    chainId: ARB,
    userAddress: USER,
    feeTokenAddress: USDT,
    operations: [{ chainId: ARB, to: USDT, value: '0', data: '0x' }],
  };

  it('prices the network cost into the fee token and adds the per-token profit, with fiat', async () => {
    const res = await http.post('/gasless/transactions/estimate').set('x-api-key', apiKey).send(body);
    expect(res.status).toBe(201);
    // rawNative = 100000*1.2 * 20_000_000 = 2.4e12 wei; @ETH $3000 = $0.0072 → 7200 USDT base;
    // + profit 0.5 USDT (500000 base) = 507200.
    expect(res.body.data.acceptedFeeToken).toBe(true);
    expect(res.body.data.feeAmount).toBe('507200');
    expect(res.body.data.feeUsd).toBe('0.5072');
    expect(res.body.data.estimatedNativeCostUsd).toBe('0.0072');
  });

  it('rejects the call without an API key (guard still in front of the new path)', async () => {
    const res = await http.post('/gasless/transactions/estimate').send(body);
    expect(res.status).toBe(401);
  });
});

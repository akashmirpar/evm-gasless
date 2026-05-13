import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Contract,
  JsonRpcProvider,
  Signature,
  TransactionReceipt,
  Wallet,
  parseUnits,
} from 'ethers';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import supertest from 'supertest';

import { AppModule } from 'src/app.module';

export interface E2EEnv {
  chainId: number;
  rpcUrl: string;
  delegateContractAddress: string;
  userWallet: Wallet;
  operatorWallet: Wallet;
  treasuryAddress: string;
  supportedFeeToken: string;
  unsupportedFeeToken: string;
}

export function readE2EEnv(): E2EEnv {
  const req = (k: string): string => {
    const v = (process.env[k] ?? '').trim();
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const chainId = Number(req('E2E_CHAIN_ID'));
  const rpcUrl = (process.env[`E2E_RPC_URL_${chainId}`] ?? process.env.E2E_RPC_URL ?? '').trim();
  if (!rpcUrl) throw new Error('missing E2E_RPC_URL');

  const userPk = req('E2E_USER_PRIVATE_KEY');
  const operatorPk = req('E2E_OPERATOR_PRIVATE_KEY');
  const delegated = (process.env.E2E_DELEGATE_CONTRACT_ADDRESS ?? '').trim();
  if (!delegated) throw new Error('missing E2E_DELEGATE_CONTRACT_ADDRESS (read from chains/deployed.json)');

  return {
    chainId,
    rpcUrl,
    delegateContractAddress: delegated,
    userWallet: new Wallet(userPk),
    operatorWallet: new Wallet(operatorPk),
    treasuryAddress: req('E2E_TREASURY_ADDRESS'),
    supportedFeeToken: req('E2E_SUPPORTED_FEE_TOKEN'),
    unsupportedFeeToken: req('E2E_UNSUPPORTED_FEE_TOKEN'),
  };
}

export async function bootBackend(extraEnv: Record<string, string>): Promise<{ app: INestApplication; http: supertest.Agent; postgres: StartedTestContainer; redis: StartedTestContainer }> {
  const postgres = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'gasless', POSTGRES_PASSWORD: 'gasless', POSTGRES_DB: 'gasless' })
    .withExposedPorts(5432)
    .withCommand(['postgres', '-c', 'fsync=off'])
    .start();
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

  process.env.DATABASE_POSTGRES_HOST = postgres.getHost();
  process.env.DATABASE_POSTGRES_PORT = String(postgres.getMappedPort(5432));
  process.env.REDIS_HOST = redis.getHost();
  process.env.REDIS_PORT = String(redis.getMappedPort(6379));
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_PIPE)
    .useFactory({ factory: () => new ValidationPipe({ whitelist: true, transform: true }) })
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const http = supertest(app.getHttpServer());
  return { app, http, postgres, redis };
}

export async function ensureUserHasNativeAndToken(env: E2EEnv, token: string, amountWei: bigint): Promise<void> {
  const provider = new JsonRpcProvider(env.rpcUrl);
  const userBalance = await provider.getBalance(env.userWallet.address);
  if (userBalance < parseUnits('0.001', 'ether')) {
    throw new Error(`user ${env.userWallet.address} needs native gas; has ${userBalance}`);
  }
  const erc20 = new Contract(
    token,
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  );
  const balance: bigint = await erc20.balanceOf(env.userWallet.address);
  if (balance < amountWei) {
    throw new Error(`user ${env.userWallet.address} needs ${amountWei} of ${token}; has ${balance}`);
  }
}

export async function signAuthorization(env: E2EEnv): Promise<{ chainId: number; address: string; nonce: string; signature: string }> {
  const provider = new JsonRpcProvider(env.rpcUrl);
  const wallet = env.userWallet.connect(provider);
  const nonce = await provider.getTransactionCount(env.userWallet.address);
  const auth = await wallet.authorize({ address: env.delegateContractAddress, nonce, chainId: env.chainId });
  return {
    chainId: env.chainId,
    address: env.delegateContractAddress,
    nonce: String(nonce),
    signature: Signature.from({ r: auth.signature.r, s: auth.signature.s, v: auth.signature.v ?? auth.signature.yParity + 27 }).serialized,
  };
}

export async function pollUntilTerminal(http: supertest.Agent, requestId: string, timeoutMs = 180_000): Promise<{ status: string; txHash: string | null; failureReason: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await http.get(`/gasless/transactions/${requestId}`);
    if (res.status === 200 && res.body?.success) {
      const data = res.body.data as { status: string; txHash: string | null; failureReason: string | null };
      if (['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT'].includes(data.status)) {
        return data;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`request ${requestId} did not reach terminal status in ${timeoutMs}ms`);
}

export async function waitForTx(rpcUrl: string, txHash: string): Promise<TransactionReceipt | null> {
  const provider = new JsonRpcProvider(rpcUrl);
  return provider.waitForTransaction(txHash);
}

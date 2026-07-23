import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  Signature,
  TransactionReceipt,
  Wallet,
  parseUnits,
} from 'ethers';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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

function resolveDelegateAddress(chainId: number): string {
  const override = (process.env.E2E_DELEGATE_CONTRACT_ADDRESS ?? '').trim();
  if (override) return override;
  const deployedPath = (process.env.DEPLOYED_JSON_PATH?.trim()) || join(__dirname, '..', '..', '..', 'chains', 'deployed.json');
  if (!existsSync(deployedPath)) {
    throw new Error(`missing E2E_DELEGATE_CONTRACT_ADDRESS and ${deployedPath} not found`);
  }
  const map = JSON.parse(readFileSync(deployedPath, 'utf8')) as Record<string, string>;
  const addr = map[String(chainId)];
  if (!addr) throw new Error(`no delegate contract address recorded for chain ${chainId} in ${deployedPath}`);
  return addr;
}

/**
 * Derive an EVM test wallet. Preferred: one `TEST_MNEMONIC` derives every e2e
 * wallet along m/44'/60'/0'/0/{index} (per-role index vars). Raw `${pkEnv}` is
 * kept only as a fallback for setups that predate the mnemonic consolidation.
 */
export function deriveEvmTestWallet(indexEnv: string, defaultIndex: number, pkEnv: string): Wallet {
  const mnemonic = (process.env.TEST_MNEMONIC ?? '').trim();
  if (mnemonic) {
    const index = Number((process.env[indexEnv] ?? String(defaultIndex)).trim() || String(defaultIndex));
    const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
    return new Wallet(hd.privateKey);
  }
  const pk = (process.env[pkEnv] ?? '').trim();
  if (!pk) throw new Error(`missing test wallet: set TEST_MNEMONIC or ${pkEnv}`);
  return new Wallet(pk);
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

  const delegated = resolveDelegateAddress(chainId);

  return {
    chainId,
    rpcUrl,
    delegateContractAddress: delegated,
    userWallet: deriveEvmTestWallet('TEST_EVM_USER_INDEX', 0, 'E2E_USER_PRIVATE_KEY'),
    operatorWallet: deriveEvmTestWallet('TEST_EVM_OPERATOR_INDEX', 1, 'E2E_OPERATOR_PRIVATE_KEY'),
    treasuryAddress: req('E2E_TREASURY_ADDRESS'),
    supportedFeeToken: req('E2E_SUPPORTED_FEE_TOKEN'),
    unsupportedFeeToken: req('E2E_UNSUPPORTED_FEE_TOKEN'),
  };
}

export interface LiveE2EEnv extends E2EEnv {
  backendUrl: string;
}

export function readLiveE2EEnv(): LiveE2EEnv {
  // Operator private key is owned by the running backend; the live test does
  // not need it, so we fill in a dummy wallet for the operator slot.
  const original = { ...process.env };
  process.env.E2E_OPERATOR_PRIVATE_KEY = process.env.E2E_OPERATOR_PRIVATE_KEY?.trim()
    || '0x0000000000000000000000000000000000000000000000000000000000000001';
  try {
    const base = readE2EEnv();
    const backendUrl = (process.env.E2E_BACKEND_URL ?? 'http://localhost:3578').replace(/\/$/, '');
    return { ...base, backendUrl };
  } finally {
    process.env = original;
  }
}

export async function pingBackend(baseUrl: string): Promise<boolean> {
  try {
    const res = await supertest(baseUrl).get('/health').timeout(3000);
    return res.status === 200;
  } catch {
    return false;
  }
}

export function httpFor(baseUrl: string): supertest.Agent {
  const agent = supertest(baseUrl);
  const apiKey = (process.env.E2E_API_KEY ?? '').trim();
  if (!apiKey) return agent;
  // The /gasless surface is guarded now — attach x-api-key to every request
  // without touching each spec's call sites.
  const verbs = new Set(['get', 'post', 'put', 'patch', 'delete']);
  const attach = (method: string) => (path: string) =>
    (agent as unknown as Record<string, (p: string) => supertest.Test>)[method](path).set('x-api-key', apiKey);
  return new Proxy(agent, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && verbs.has(prop)) return attach(prop);
      return Reflect.get(target, prop, receiver);
    },
  }) as supertest.Agent;
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

export async function ensureUserHasNativeAndToken(env: E2EEnv, token: string, minTokenWei: bigint): Promise<void> {
  const provider = new JsonRpcProvider(env.rpcUrl);
  try {
    const erc20 = new Contract(
      token,
      ['function balanceOf(address) view returns (uint256)'],
      provider,
    );
    const balance: bigint = await erc20.balanceOf(env.userWallet.address);
    if (balance < minTokenWei) {
      throw new Error(
        `user ${env.userWallet.address} needs at least ${minTokenWei} base units of ${token}; has ${balance}. ` +
        `Fund the wallet or lower the minimum to continue.`,
      );
    }
    const operatorBalance = await provider.getBalance(env.operatorWallet.address);
    if (operatorBalance < parseUnits('0.0005', 'ether')) {
      throw new Error(`operator ${env.operatorWallet.address} needs at least 0.0005 native to broadcast; has ${operatorBalance}`);
    }
  } finally {
    provider.destroy();
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

const DELEGATE_NONCE_ABI = ['function nonce() view returns (uint256)'];

const PUBLIC_RPC_DEFAULTS: Record<number, string[]> = {
  56: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
  ],
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
};

const ENV_VAR_BY_CHAIN: Record<number, string> = {
  56: 'BSC_RPC_URLS',
  8453: 'BASE_RPC_URLS',
  42161: 'ARBITRUM_RPC_URLS',
};

function rpcsForChain(chainId: number, fallback: string): string[] {
  const envVar = ENV_VAR_BY_CHAIN[chainId];
  const envValue = envVar ? (process.env[envVar] ?? '').trim() : '';
  const override = envValue
    ? envValue.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (override.length > 0) return override;
  return PUBLIC_RPC_DEFAULTS[chainId] ?? [fallback];
}

function delegatePointsAt(code: string, expectedDelegate: string): boolean {
  if (!code || code === '0x') return false;
  const lc = code.toLowerCase();
  if (!lc.startsWith('0xef0100')) return false;
  const target = '0x' + lc.slice(8);
  return target === expectedDelegate.toLowerCase();
}

async function nonceAcrossRpcs(userAddress: string, expectedDelegate: string, rpcUrls: string[]): Promise<bigint[]> {
  const results = await Promise.allSettled(
    rpcUrls.map(async (url) => {
      const p = new JsonRpcProvider(url);
      try {
        const code = await p.getCode(userAddress);
        if (code === '0x' || code === '0x0' || code === '' || !delegatePointsAt(code, expectedDelegate)) {
          return 0n;
        }
        const c = new Contract(userAddress, DELEGATE_NONCE_ABI, p);
        return BigInt(await c.nonce());
      } finally {
        p.destroy();
      }
    }),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

export async function signTypedDataForBatch(
  env: E2EEnv,
  ops: Array<{ to: string; value: string; data: string }>,
  atomicGroupStart: number,
  nonce: string,
): Promise<string> {
  const domain = { name: 'GaslessDelegate', version: '1', chainId: env.chainId, verifyingContract: env.userWallet.address };
  const types = {
    Operation: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    Batch: [
      { name: 'operations', type: 'Operation[]' },
      { name: 'atomicGroupStart', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
  const value = { operations: ops, atomicGroupStart, nonce };
  return env.userWallet.signTypedData(domain, types, value);
}

/**
 * Waits until every reachable BSC RPC reports the same nonce for our user EOA.
 * On public RPC pools, the load balancer can route consecutive requests to
 * backend nodes that lag the chain by a block — so a "max across RPCs" view
 * can be stale during quick handoffs between tests. Requiring full agreement
 * across the fleet eliminates that race.
 */
export async function waitForStableNonce(env: E2EEnv, maxAttempts = 30): Promise<bigint> {
  const rpcs = rpcsForChain(env.chainId, env.rpcUrl);
  for (let i = 0; i < maxAttempts; i++) {
    const values = await nonceAcrossRpcs(env.userWallet.address, env.delegateContractAddress, rpcs);
    if (values.length > 0 && values.every((v) => v === values[0])) {
      return values[0];
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`on-chain nonce did not stabilize across RPCs within ${maxAttempts} attempts`);
}

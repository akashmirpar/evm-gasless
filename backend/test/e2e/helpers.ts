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
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { DataSource } from 'typeorm';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import supertest from 'supertest';

import { AppModule } from 'src/app.module';
import { __resetConfigCache } from 'src/config/yaml_reader';
import { __resetSecretCache } from 'src/config/secret_reader';
import { ApiKeyEntity } from 'src/modules/auth/domain/entity/api_key.entity';

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

export function resolveBroadcastOperatorAddress(fallback: Wallet): string {
  const mnemonic = (process.env.OPERATOR_MNEMONIC ?? '').trim();
  if (mnemonic) {
    const index = Number((process.env.OPERATOR_MNEMONIC_INDEX ?? '0').trim() || '0');
    return HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`).address;
  }
  const pk = (process.env.OPERATOR_PRIVATE_KEY ?? '').trim();
  if (pk) return new Wallet(pk).address;
  return fallback.address;
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

// The /gasless surface is guarded now — attach x-api-key to every request
// without touching each spec's call sites.
export function attachApiKey(agent: supertest.Agent, apiKey: string): supertest.Agent {
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

// Suites that boot their own database start with an empty api_key table, so they
// mint their own key rather than depending on a row another suite left behind.
export async function seedApiKey(app: INestApplication): Promise<string> {
  const key = randomUUID();
  await app.get(DataSource).getRepository(ApiKeyEntity).save({
    clientName: 'e2e',
    key,
    isActive: true,
    rateLimitRps: 1000,
  });
  return key;
}

export function httpFor(baseUrl: string): supertest.Agent {
  const agent = supertest(baseUrl);
  const apiKey = (process.env.E2E_API_KEY ?? '').trim();
  if (!apiKey) return agent;
  return attachApiKey(agent, apiKey);
}

function writeE2ESecretFile(overrides: Record<string, string>): string {
  const source = (process.env.GASLESS_ENV_FILE ?? '').trim() || resolve(process.cwd(), '.env');
  const inherited = existsSync(source)
    ? readFileSync(source, 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        const eq = trimmed.indexOf('=');
        return eq > 0 && !(trimmed.slice(0, eq).trim() in overrides);
      })
    : [];
  const merged = [...inherited, ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`)].join('\n');
  const file = join(mkdtempSync(join(tmpdir(), 'gasless-e2e-')), 'secrets.env');
  writeFileSync(file, `${merged}\n`);
  return file;
}

export async function bootBackend(extraEnv: Record<string, string>): Promise<{ app: INestApplication; http: supertest.Agent; postgres: StartedTestContainer; redis: StartedTestContainer }> {
  const postgres = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'gasless', POSTGRES_PASSWORD: 'gasless', POSTGRES_DB: 'gasless' })
    .withExposedPorts(5432)
    .withCommand(['postgres', '-c', 'fsync=off'])
    .start();
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

  const overrides: Record<string, string> = {
    DATABASE_POSTGRES_HOST: postgres.getHost(),
    DATABASE_POSTGRES_PORT: String(postgres.getMappedPort(5432)),
    REDIS_HOST: redis.getHost(),
    REDIS_PORT: String(redis.getMappedPort(6379)),
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  // The secret file outranks process.env (src/config/secret_reader), so setting
  // process.env alone leaves the app pointed at whatever database the developer's
  // .env pins — i.e. the shared dev database these containers exist to avoid.
  // Inject through the secret file instead, inheriting the real secrets.
  process.env.GASLESS_ENV_FILE = writeE2ESecretFile(overrides);
  // Both readers cache their parsed file in module state, and importing the app
  // already populated that cache from the developer's .env.
  __resetSecretCache();
  __resetConfigCache();

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
    const operatorAddress = resolveBroadcastOperatorAddress(env.operatorWallet);
    const operatorBalance = await provider.getBalance(operatorAddress);
    if (operatorBalance < parseUnits('0.0005', 'ether')) {
      throw new Error(`operator ${operatorAddress} needs at least 0.0005 native to broadcast; has ${operatorBalance}`);
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

import { INestApplication } from '@nestjs/common';
import { Contract, JsonRpcProvider, parseUnits } from 'ethers';
import { StartedTestContainer } from 'testcontainers';
import supertest from 'supertest';

import {
  bootBackend,
  E2EEnv,
  ensureUserHasNativeAndToken,
  pollUntilTerminal,
  readE2EEnv,
  signAuthorization,
} from './helpers';

const ERC20_BALANCE_OF = ['function balanceOf(address) view returns (uint256)'];

const supportedFeeTokenAvailable = !!(process.env.E2E_USER_PRIVATE_KEY && process.env.E2E_OPERATOR_PRIVATE_KEY);
const describeIfFunded = supportedFeeTokenAvailable ? describe : describe.skip;

describeIfFunded('gasless e2e (real chain)', () => {
  let app: INestApplication;
  let http: supertest.Agent;
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  let env: E2EEnv;

  beforeAll(async () => {
    env = readE2EEnv();
    const booted = await bootBackend({
      OPERATOR_PRIVATE_KEY: env.operatorWallet.privateKey,
      GASLESS_TREASURY_ADDRESS: env.treasuryAddress,
      GASLESS_ACCEPTED_FEE_TOKENS: env.supportedFeeToken.toLowerCase(),
      [`E2E_RPC_URL_${env.chainId}`]: env.rpcUrl,
    });
    app = booted.app;
    http = booted.http;
    postgres = booted.postgres;
    redis = booted.redis;
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  it('supported fee token path: direct treasury transfer in must-succeed zone', async () => {
    const feeAmountMinimum = parseUnits('1', 6);
    await ensureUserHasNativeAndToken(env, env.supportedFeeToken, feeAmountMinimum);

    const ops = [
      {
        chainId: env.chainId,
        to: env.userWallet.address,
        value: '0',
        data: '0x',
      },
    ];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.supportedFeeToken,
        operations: ops,
      })
      .expect(200);
    expect(estimate.body.data.acceptedFeeToken).toBe(true);

    const create = await http
      .post('/gasless/transactions')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.supportedFeeToken,
        operations: ops,
      })
      .expect(201);
    const { requestId, digest, operations: prepared, atomicGroupStart, nonce } = create.body.data;
    expect(atomicGroupStart).toBe(1);
    expect(prepared.length).toBe(2);

    const signature = await signTypedDataForBatch(env, prepared, atomicGroupStart, nonce);
    const authorization = await signAuthorization(env);

    await http
      .post(`/gasless/transactions/${requestId}/submit`)
      .send({ signature, authorization })
      .expect(201);

    const final = await pollUntilTerminal(http, requestId);
    expect(final.status).toBe('MINED_SUCCESS');
    expect(final.txHash).toBeTruthy();

    const provider = new JsonRpcProvider(env.rpcUrl);
    const erc20 = new Contract(env.supportedFeeToken, ERC20_BALANCE_OF, provider);
    const treasuryAfter: bigint = await erc20.balanceOf(env.treasuryAddress);
    expect(treasuryAfter > 0n).toBe(true);
  }, 300_000);

  it('unsupported fee token path: approve + rango swap to accepted, then user ops', async () => {
    const feeAmountMinimum = parseUnits('5', 18);
    await ensureUserHasNativeAndToken(env, env.unsupportedFeeToken, feeAmountMinimum);

    const ops = [
      {
        chainId: env.chainId,
        to: env.userWallet.address,
        value: '0',
        data: '0x',
      },
    ];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.unsupportedFeeToken,
        operations: ops,
      })
      .expect(200);
    expect(estimate.body.data.acceptedFeeToken).toBe(false);
    expect(estimate.body.data.swapRoute).toBeTruthy();

    const create = await http
      .post('/gasless/transactions')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.unsupportedFeeToken,
        operations: ops,
      })
      .expect(201);
    const { requestId, operations: prepared, atomicGroupStart, nonce } = create.body.data;
    expect(atomicGroupStart).toBeGreaterThanOrEqual(1);
    expect(prepared.length).toBeGreaterThan(atomicGroupStart);

    const signature = await signTypedDataForBatch(env, prepared, atomicGroupStart, nonce);
    const authorization = await signAuthorization(env);

    await http
      .post(`/gasless/transactions/${requestId}/submit`)
      .send({ signature, authorization })
      .expect(201);

    const final = await pollUntilTerminal(http, requestId);
    expect(final.status).toBe('MINED_SUCCESS');
    expect(final.txHash).toBeTruthy();
  }, 300_000);
});

async function signTypedDataForBatch(
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

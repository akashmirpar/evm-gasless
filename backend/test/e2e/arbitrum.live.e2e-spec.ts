import { Contract, Interface, JsonRpcProvider, parseUnits } from 'ethers';
import supertest from 'supertest';

import {
  ensureUserHasNativeAndToken,
  httpFor,
  LiveE2EEnv,
  pingBackend,
  pollUntilTerminal,
  readLiveE2EEnv,
  signAuthorization,
  signTypedDataForBatch,
  waitForStableNonce,
} from './helpers';

const ARB_CHAIN_ID = 42161;
const ARB_USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARB_RPC_DEFAULT = 'https://arbitrum-one-rpc.publicnode.com';
const USER_OP_RECIPIENT = '0x3d2f7550C63F3b6E6A9a24D0a226f6ae0c48749F';

const ERC20_BALANCE_OF = ['function balanceOf(address) view returns (uint256)'];
const ERC20_IFACE = new Interface(['function transfer(address to, uint256 amount)']);

const liveEnabled = !!(process.env.E2E_USER_PRIVATE_KEY && (process.env.E2E_BACKEND_URL || process.env.E2E_LIVE === '1'));
const describeIfLive = liveEnabled ? describe : describe.skip;

async function tokenDecimals(rpcUrl: string, token: string): Promise<number> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const c = new Contract(token, ['function decimals() view returns (uint8)'], provider);
    return Number(await c.decimals());
  } finally {
    provider.destroy();
  }
}

function makeTransferOp(chainId: number, token: string, recipient: string, humanAmount: string, decimals: number) {
  return {
    chainId,
    to: token,
    value: '0',
    data: ERC20_IFACE.encodeFunctionData('transfer', [recipient, parseUnits(humanAmount, decimals)]),
  };
}

describeIfLive('gasless e2e — Arbitrum One (chain 42161) against running backend', () => {
  let env: LiveE2EEnv;
  let http: supertest.Agent;

  beforeAll(async () => {
    const saved = {
      chain: process.env.E2E_CHAIN_ID,
      rpc: process.env.E2E_RPC_URL,
      supported: process.env.E2E_SUPPORTED_FEE_TOKEN,
      unsupported: process.env.E2E_UNSUPPORTED_FEE_TOKEN,
    };
    process.env.E2E_CHAIN_ID = String(ARB_CHAIN_ID);
    process.env.E2E_RPC_URL = process.env.E2E_RPC_URL_42161 ?? ARB_RPC_DEFAULT;
    process.env.E2E_SUPPORTED_FEE_TOKEN = ARB_USDT;
    process.env.E2E_UNSUPPORTED_FEE_TOKEN = ARB_USDC;
    try {
      env = readLiveE2EEnv();
    } finally {
      if (saved.chain === undefined) delete process.env.E2E_CHAIN_ID; else process.env.E2E_CHAIN_ID = saved.chain;
      if (saved.rpc === undefined) delete process.env.E2E_RPC_URL; else process.env.E2E_RPC_URL = saved.rpc;
      if (saved.supported === undefined) delete process.env.E2E_SUPPORTED_FEE_TOKEN; else process.env.E2E_SUPPORTED_FEE_TOKEN = saved.supported;
      if (saved.unsupported === undefined) delete process.env.E2E_UNSUPPORTED_FEE_TOKEN; else process.env.E2E_UNSUPPORTED_FEE_TOKEN = saved.unsupported;
    }
    if (!(await pingBackend(env.backendUrl))) {
      throw new Error(`backend at ${env.backendUrl} is not reachable`);
    }
    http = httpFor(env.backendUrl);
  });

  it('estimate is served — proves 20003 CHAIN_NO_DEPLOYED_CONTRACT is gone', async () => {
    const usdtDecimals = await tokenDecimals(env.rpcUrl, env.supportedFeeToken);
    const ops = [makeTransferOp(env.chainId, env.supportedFeeToken, USER_OP_RECIPIENT, '0.0001', usdtDecimals)];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.supportedFeeToken,
        operations: ops,
      })
      .expect(201);

    expect(estimate.body.success).toBe(true);
    expect(estimate.body.data.acceptedFeeToken).toBe(true);
    expect(BigInt(estimate.body.data.feeAmount)).toBeGreaterThan(0n);
    expect(estimate.body.data.feeTokenAddress.toLowerCase()).toBe(env.supportedFeeToken.toLowerCase());
    console.log(`Arb USDT fee estimate: ${estimate.body.data.feeAmount} base units (6-dec)`);
  });

  it('supported fee token path: USDT transfer → sign → submit → mined', async () => {
    const feeAmountMinimum = parseUnits('0.05', 6);
    await ensureUserHasNativeAndToken(env, env.supportedFeeToken, feeAmountMinimum);
    await waitForStableNonce(env);

    const usdtDecimals = await tokenDecimals(env.rpcUrl, env.supportedFeeToken);
    const ops = [makeTransferOp(env.chainId, env.supportedFeeToken, USER_OP_RECIPIENT, '0.0001', usdtDecimals)];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.supportedFeeToken,
        operations: ops,
      })
      .expect(201);
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
    const { requestId, operations: prepared, atomicGroupStart, nonce } = create.body.data;

    const signature = await signTypedDataForBatch(env, prepared, atomicGroupStart, nonce);
    const authorization = await signAuthorization(env);

    await http
      .post(`/gasless/transactions/${requestId}/submit`)
      .send({ signature, authorization })
      .expect(201);

    const final = await pollUntilTerminal(http, requestId, 240_000);
    if (final.status !== 'MINED_SUCCESS') {
      console.error('arbitrum e2e on-chain failure:', JSON.stringify(final));
    }
    expect(final.status).toBe('MINED_SUCCESS');
    expect(final.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    console.log(`Arbitrum tx: https://arbiscan.io/tx/${final.txHash}`);

    const provider = new JsonRpcProvider(env.rpcUrl);
    try {
      const erc20 = new Contract(env.supportedFeeToken, ERC20_BALANCE_OF, provider);
      const treasuryAfter: bigint = await erc20.balanceOf(env.treasuryAddress);
      expect(treasuryAfter > 0n).toBe(true);
    } finally {
      provider.destroy();
    }
  }, 300_000);
});

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
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USER_OP_RECIPIENT = '0x3d2f7550C63F3b6E6A9a24D0a226f6ae0c48749F';

const ERC20_BALANCE_OF = ['function balanceOf(address) view returns (uint256)'];
const ERC20_IFACE = new Interface(['function transfer(address to, uint256 amount)']);

const liveEnabled = !!((process.env.E2E_USER_PRIVATE_KEY || process.env.TEST_MNEMONIC) && (process.env.E2E_BACKEND_URL || process.env.E2E_LIVE === '1'));
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

describeIfLive('gasless e2e — RIN-113 any-token-fee (Arb chain 42161)', () => {
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

  it('reproducer succeeds — native ETH fee estimate returns 201 with populated swapRoute (no 20004)', async () => {
    const usdtDecimals = await tokenDecimals(env.rpcUrl, env.supportedFeeToken);
    const ops = [makeTransferOp(env.chainId, env.supportedFeeToken, USER_OP_RECIPIENT, '0.0001', usdtDecimals)];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: NATIVE_SENTINEL,
        operations: ops,
      })
      .expect(201);

    expect(estimate.body.success).toBe(true);
    expect(estimate.body.data.acceptedFeeToken).toBe(false);
    expect(estimate.body.data.feeTokenAddress).toBe(NATIVE_SENTINEL);
    expect(estimate.body.data.swapRoute).toBeTruthy();
    expect(estimate.body.data.swapRoute.inputToken).toBe(NATIVE_SENTINEL);
    expect(estimate.body.data.swapRoute.outputToken.toLowerCase()).toBe(env.supportedFeeToken.toLowerCase());
    expect(BigInt(estimate.body.data.feeAmount)).toBeGreaterThan(0n);
    console.log(`Native ETH fee estimate: ${estimate.body.data.feeAmount} wei → ${estimate.body.data.swapRoute.outputAmount} USDT base units`);
  });

  it('native ETH fee → sign → submit → mined (Rango-routed native → USDT swap into treasury)', async () => {
    await waitForStableNonce(env);

    const usdtDecimals = await tokenDecimals(env.rpcUrl, env.supportedFeeToken);
    const ops = [makeTransferOp(env.chainId, env.supportedFeeToken, USER_OP_RECIPIENT, '0.0001', usdtDecimals)];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: NATIVE_SENTINEL,
        operations: ops,
      })
      .expect(201);
    const feeAmountWei = BigInt(estimate.body.data.feeAmount);
    console.log(`Fee: ${feeAmountWei} wei (~$${(Number(feeAmountWei) / 1e18 * 3400).toFixed(4)} @ ETH $3400)`);

    // Balance guard so we don't spend cycles chasing a mined tx that would 40009.
    const provider = new JsonRpcProvider(env.rpcUrl);
    try {
      const userEthBal = await provider.getBalance(env.userWallet.address);
      if (BigInt(userEthBal) < feeAmountWei) {
        throw new Error(`user ${env.userWallet.address} needs ${feeAmountWei} wei ETH; has ${userEthBal}`);
      }
      const treasuryBefore: bigint = await new Contract(env.supportedFeeToken, ERC20_BALANCE_OF, provider).balanceOf(env.treasuryAddress);
      const create = await http
        .post('/gasless/transactions')
        .send({
          chainId: env.chainId,
          userAddress: env.userWallet.address,
          feeTokenAddress: NATIVE_SENTINEL,
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
        console.error('any-token-fee on-chain failure:', JSON.stringify(final));
      }
      expect(final.status).toBe('MINED_SUCCESS');
      expect(final.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
      console.log(`Arbitrum tx (native fee): https://arbiscan.io/tx/${final.txHash}`);

      const treasuryAfter: bigint = await new Contract(env.supportedFeeToken, ERC20_BALANCE_OF, provider).balanceOf(env.treasuryAddress);
      expect(treasuryAfter > treasuryBefore).toBe(true);
      console.log(`Treasury USDT delta: +${treasuryAfter - treasuryBefore} base units`);
    } finally {
      provider.destroy();
    }
  }, 300_000);

  it('accepted USDT (regression) — direct-accept path still works with new config', async () => {
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
    expect(estimate.body.data.swapRoute).toBeUndefined();
    console.log(`Accepted USDT fee estimate: ${estimate.body.data.feeAmount} base units`);
  });
});

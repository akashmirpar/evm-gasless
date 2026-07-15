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

const ERC20_BALANCE_OF = ['function balanceOf(address) view returns (uint256)'];
const ERC20_IFACE = new Interface(['function transfer(address to, uint256 amount)']);
const USER_OP_RECIPIENT = '0x3d2f7550C63F3b6E6A9a24D0a226f6ae0c48749F';

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

describeIfLive('gasless e2e against a running backend instance', () => {
  let env: LiveE2EEnv;
  let http: supertest.Agent;

  beforeAll(async () => {
    env = readLiveE2EEnv();
    if (!(await pingBackend(env.backendUrl))) {
      throw new Error(`backend at ${env.backendUrl} is not reachable; start it before running this suite`);
    }
    http = httpFor(env.backendUrl);
  });

  it('supported fee token path against running instance', async () => {
    const feeAmountMinimum = parseUnits('1', 6);
    await ensureUserHasNativeAndToken(env, env.supportedFeeToken, feeAmountMinimum);
    await waitForStableNonce(env);

    const supportedDecimals = await tokenDecimals(env.rpcUrl, env.supportedFeeToken);
    const ops = [makeTransferOp(env.chainId, env.supportedFeeToken, USER_OP_RECIPIENT, '0.0001', supportedDecimals)];

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

    const final = await pollUntilTerminal(http, requestId);
    if (final.status !== 'MINED_SUCCESS') {
      console.error('supported (live) on-chain failure:', JSON.stringify(final));
    }
    expect(final.status).toBe('MINED_SUCCESS');

    const provider = new JsonRpcProvider(env.rpcUrl);
    const erc20 = new Contract(env.supportedFeeToken, ERC20_BALANCE_OF, provider);
    const treasuryAfter: bigint = await erc20.balanceOf(env.treasuryAddress);
    expect(treasuryAfter > 0n).toBe(true);
  }, 300_000);

  it('unsupported fee token path against running instance', async () => {
    // Just enough to cover the swap-fee (a few cents in BTCB), not an arbitrary 5-token bar.
    const feeAmountMinimum = parseUnits('0.0001', 18);
    await ensureUserHasNativeAndToken(env, env.unsupportedFeeToken, feeAmountMinimum);
    await waitForStableNonce(env);

    const unsupportedDecimals = await tokenDecimals(env.rpcUrl, env.unsupportedFeeToken);
    const ops = [makeTransferOp(env.chainId, env.unsupportedFeeToken, USER_OP_RECIPIENT, '0.0001', unsupportedDecimals)];

    const estimate = await http
      .post('/gasless/transactions/estimate')
      .send({
        chainId: env.chainId,
        userAddress: env.userWallet.address,
        feeTokenAddress: env.unsupportedFeeToken,
        operations: ops,
      })
      .expect(201);
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

    const signature = await signTypedDataForBatch(env, prepared, atomicGroupStart, nonce);
    const authorization = await signAuthorization(env);

    await http
      .post(`/gasless/transactions/${requestId}/submit`)
      .send({ signature, authorization })
      .expect(201);

    const final = await pollUntilTerminal(http, requestId);
    if (final.status !== 'MINED_SUCCESS') {
      console.error('unsupported (live) on-chain failure:', JSON.stringify(final));
    }
    expect(final.status).toBe('MINED_SUCCESS');
  }, 300_000);
});


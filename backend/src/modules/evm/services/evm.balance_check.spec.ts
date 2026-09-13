import type { ConfigService } from '@nestjs/config';

import { EvmService } from './evm.service';
import { NATIVE_TOKEN_SENTINEL } from '../../../core/chain_config/chain_config.service';

type BalanceMap = { native: bigint; erc20: bigint };

function makeService(balances: BalanceMap): EvmService {
  // Fake omnichain EvmChain: getBalance(owner) → native wei;
  // getBalance(owner, tokenId) → ERC-20 balance.
  const chain = {
    getBalance: async (_owner: string, tokenId?: string) => (tokenId ? balances.erc20 : balances.native),
  };
  const rpc = {
    withChain: jest.fn(async (_id: number, fn: (c: unknown) => Promise<unknown>) => fn(chain as never)),
  } as never;
  return new EvmService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    rpc,
    { get: () => undefined } as unknown as ConfigService,
  );
}

function callAssert(svc: EvmService, args: {
  feeTokenAddress: string;
  feeAmount: bigint;
  operations: Array<{ value: string }>;
  atomicGroupStart: number;
}) {
  return (svc as unknown as {
    assertUserBalanceCoversFee: (
      chainId: number,
      user: string,
      feeToken: string,
      feeAmount: bigint,
      ops: Array<{ value: string }>,
      atomicGroupStart: number,
    ) => Promise<void>;
  }).assertUserBalanceCoversFee(42161, '0xuser', args.feeTokenAddress, args.feeAmount, args.operations, args.atomicGroupStart);
}

describe('EvmService.assertUserBalanceCoversFee — RIN-113 fix', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('native fee token — post-fix must NOT double-count', () => {
    it('passes when balance == feeAmount exactly, prelude swap op holds feeAmount, user ops have 0 value', async () => {
      // The regression the reviewer caught: pre-fix, `required = 2 * feeAmount`
      // because the prelude swap op's value (already = feeAmount) was summed
      // in on top of feeAmount. First-time-user with exactly feeAmount ETH
      // would get locked out at submit.
      const feeAmount = 1_780_000_000_000n;
      const svc = makeService({ native: feeAmount, erc20: 0n });
      await expect(callAssert(svc, {
        feeTokenAddress: NATIVE_TOKEN_SENTINEL,
        feeAmount,
        operations: [
          // atomicGroupStart = 1 → prelude is [swap op with value = feeAmount].
          { value: feeAmount.toString() },
          // user op with value = 0.
          { value: '0' },
        ],
        atomicGroupStart: 1,
      })).resolves.toBeUndefined();
    });

    it('rejects when balance < feeAmount', async () => {
      const feeAmount = 1_780_000_000_000n;
      const svc = makeService({ native: feeAmount - 1n, erc20: 0n });
      await expect(callAssert(svc, {
        feeTokenAddress: NATIVE_TOKEN_SENTINEL,
        feeAmount,
        operations: [{ value: feeAmount.toString() }, { value: '0' }],
        atomicGroupStart: 1,
      })).rejects.toMatchObject({ errorInfo: expect.objectContaining({ code: 40009 }) });
    });

    it('rejects when a user op adds native value that pushes required over balance', async () => {
      const feeAmount = 1_780_000_000_000n;
      const userValue = 5_000n;
      const svc = makeService({ native: feeAmount + userValue - 1n, erc20: 0n });
      await expect(callAssert(svc, {
        feeTokenAddress: NATIVE_TOKEN_SENTINEL,
        feeAmount,
        operations: [{ value: feeAmount.toString() }, { value: userValue.toString() }],
        atomicGroupStart: 1,
      })).rejects.toMatchObject({ errorInfo: expect.objectContaining({ code: 40009 }) });
    });
  });

  describe('ERC-20 fee token', () => {
    it('passes when ERC-20 balance == feeAmount and user ops have no value', async () => {
      const feeAmount = 4413n;
      const svc = makeService({ native: 0n, erc20: feeAmount });
      await expect(callAssert(svc, {
        feeTokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        feeAmount,
        operations: [
          { value: '0' }, // prelude ERC-20 transfer to treasury
          { value: '0' }, // user op
        ],
        atomicGroupStart: 1,
      })).resolves.toBeUndefined();
    });

    it('rejects when ERC-20 balance is short even by 1 wei', async () => {
      const svc = makeService({ native: 999n, erc20: 4412n });
      await expect(callAssert(svc, {
        feeTokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        feeAmount: 4413n,
        operations: [{ value: '0' }, { value: '0' }],
        atomicGroupStart: 1,
      })).rejects.toMatchObject({ errorInfo: expect.objectContaining({ code: 40009 }) });
    });

    it('rejects when a user op sends more native than the user holds even though ERC-20 fee is covered', async () => {
      const svc = makeService({ native: 100n, erc20: 4413n });
      await expect(callAssert(svc, {
        feeTokenAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        feeAmount: 4413n,
        operations: [{ value: '0' }, { value: '200' }],
        atomicGroupStart: 1,
      })).rejects.toMatchObject({ errorInfo: expect.objectContaining({ code: 40009 }) });
    });
  });
});

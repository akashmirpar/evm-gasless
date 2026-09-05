import { AbiCoder } from 'ethers';

import { DelegateStateService } from './delegate_state.service';

const OUR_DELEGATE = '0x7AF705BEA2Aa1F1cB4ffB18cbB94B26Bba343a87';
const coder = AbiCoder.defaultAbiCoder();

// Fake omnichain EvmChain: `getDelegation` parses the 7702 designator from a
// code map; `call` returns the ABI-encoded nonce (or throws to model a revert).
class FakeChain {
  constructor(
    private codeMap: Record<string, string>,
    private nonceMap: Record<string, bigint | Error>,
  ) {}

  async getDelegation(addr: string): Promise<{ delegate: string } | null> {
    const code = (this.codeMap[addr.toLowerCase()] ?? '0x').toLowerCase();
    if (!code.startsWith('0xef0100') || code.length < 48) return null;
    return { delegate: '0x' + code.slice(8) };
  }

  async call({ to }: { to: string; data: string }): Promise<{ result?: string }> {
    const v = this.nonceMap[to.toLowerCase()];
    if (v instanceof Error) throw v;
    return { result: coder.encode(['uint256'], [v ?? 0n]) };
  }
}

function makeService(codeMap: Record<string, string>, nonceMap: Record<string, bigint | Error>): DelegateStateService {
  const chainConfig = {
    get: () => ({ rpcUrls: ['https://rpc.a', 'https://rpc.b'] }),
    requireDelegateAddress: () => OUR_DELEGATE,
  } as never;
  const chain = new FakeChain(codeMap, nonceMap);
  const rpc = {
    evmChainsFor: () => [chain, chain] as never,
    withChain: async (_id: number, fn: (c: unknown) => Promise<bigint>) => fn(chain),
  } as never;
  return new DelegateStateService(chainConfig, rpc);
}

describe('DelegateStateService.readNonce — fresh-EOA regression (M7 follow-up)', () => {
  const USER = '0x886b748C1000000000000000000000000000AAAA';

  it('returns 0n for a fresh EOA (no delegation), does NOT throw', async () => {
    const svc = makeService({ [USER.toLowerCase()]: '0x' }, {});
    await expect(svc.readNonce(56, USER)).resolves.toBe(0n);
  });

  it('returns nonce when address is delegated to OUR delegate', async () => {
    const svc = makeService(
      { [USER.toLowerCase()]: '0xef0100' + OUR_DELEGATE.slice(2).toLowerCase() },
      { [USER.toLowerCase()]: 5n },
    );
    await expect(svc.readNonce(56, USER)).resolves.toBe(5n);
  });

  it('returns 0n when address is delegated to a DIFFERENT contract (auth submit will overwrite)', async () => {
    const svc = makeService(
      { [USER.toLowerCase()]: '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b' },
      {},
    );
    await expect(svc.readNonce(56, USER)).resolves.toBe(0n);
  });

  it('throws typed CHAIN_RPC_UNAVAILABLE when delegated to us but nonce() reverts', async () => {
    const svc = makeService(
      { [USER.toLowerCase()]: '0xef0100' + OUR_DELEGATE.slice(2).toLowerCase() },
      { [USER.toLowerCase()]: new Error('call reverted') },
    );
    await expect(svc.readNonce(56, USER)).rejects.toMatchObject({
      errorInfo: expect.objectContaining({ code: 20002 }),
    });
  });
});

import { toBeHex } from 'ethers';

import { DelegateStateService } from './delegate_state.service';

const NONCE_SLOT = 2n;

// Fake omnichain EvmChain: `getProvider().getStorage` serves the EOA's storage,
// keyed by address → slot → value. Delegation state is deliberately absent —
// the nonce read must not depend on it.
class FakeChain {
  constructor(private storage: Record<string, Record<string, bigint | Error>>) {}

  getProvider() {
    return {
      getStorage: async (addr: string, slot: bigint): Promise<string> => {
        const v = this.storage[addr.toLowerCase()]?.[slot.toString()];
        if (v instanceof Error) throw v;
        return toBeHex(v ?? 0n, 32);
      },
    };
  }
}

function makeService(chains: FakeChain[]): DelegateStateService {
  const rpc = {
    evmChainsFor: () => chains as never,
    withChain: async (_id: number, fn: (c: unknown) => Promise<bigint>) => {
      for (const c of chains) {
        try { return await fn(c); } catch { /* try the next endpoint */ }
      }
      throw Object.assign(new Error('all rpcs failed'), { errorInfo: { code: 20002 } });
    },
  } as never;
  return new DelegateStateService(rpc);
}

const USER = '0x886b748C1000000000000000000000000000AAAA';
const at = (nonce: bigint | Error) => ({ [USER.toLowerCase()]: { [NONCE_SLOT.toString()]: nonce } });

describe('DelegateStateService.readNonce', () => {
  it('returns 0n for a fresh EOA (empty storage)', async () => {
    await expect(makeService([new FakeChain({})]).readNonce(56, USER)).resolves.toBe(0n);
  });

  it('returns the nonce held in the EOA storage slot', async () => {
    await expect(makeService([new FakeChain(at(5n))]).readNonce(56, USER)).resolves.toBe(5n);
  });

  // The migration case that produced InvalidNonce on-chain: the EOA is still
  // delegated to a previous delegate address, but its storage carries the
  // nonce advanced under that delegate. Re-delegating keeps the storage.
  it('reads the storage nonce regardless of which delegate the EOA currently points at', async () => {
    await expect(makeService([new FakeChain(at(1n))]).readNonce(56, USER)).resolves.toBe(1n);
  });

  it('takes the max across RPCs when one lags', async () => {
    const svc = makeService([new FakeChain(at(3n)), new FakeChain(at(4n))]);
    await expect(svc.readNonce(56, USER)).resolves.toBe(4n);
  });

  it('a single failing RPC does not mask the others', async () => {
    const svc = makeService([new FakeChain(at(new Error('timeout'))), new FakeChain(at(7n))]);
    await expect(svc.readNonce(56, USER)).resolves.toBe(7n);
  });

  it('surfaces CHAIN_RPC_UNAVAILABLE when every RPC fails', async () => {
    const svc = makeService([new FakeChain(at(new Error('down'))), new FakeChain(at(new Error('down')))]);
    await expect(svc.readNonce(56, USER)).rejects.toMatchObject({ errorInfo: { code: 20002 } });
  });
});

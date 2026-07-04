import { DelegateStateService } from './delegate_state.service';

class FakeProvider {
  constructor(private codeMap: Record<string, string>, private nonceMap: Record<string, bigint | Error>) {}
  async getCode(addr: string): Promise<string> { return this.codeMap[addr.toLowerCase()] ?? '0x'; }
  destroy(): void {}
}

function makeService(codeMap: Record<string, string>, nonceMap: Record<string, bigint | Error>): DelegateStateService {
  const rpcs = ['https://rpc.a', 'https://rpc.b'];
  const chainConfig = { get: () => ({ rpcUrls: rpcs }) } as never;
  const provider = new FakeProvider(codeMap, nonceMap);
  const rpc = {
    providerFor: () => provider as never,
    withFallback: async (_id: number, fn: (p: unknown) => Promise<bigint>) => fn(provider),
  } as never;
  const svc = new DelegateStateService(chainConfig, rpc);
  const jsonEthers = require('ethers');
  const contractSpy = jest.spyOn(jsonEthers, 'Contract').mockImplementation((addr) => {
    const key = String(addr).toLowerCase();
    return {
      nonce: async () => {
        const v = nonceMap[key];
        if (v instanceof Error) throw v;
        return v;
      },
    } as never;
  });
  (svc as unknown as { __spy: unknown }).__spy = contractSpy;
  return svc;
}

describe('DelegateStateService.readNonce — fresh-EOA regression (M7 follow-up)', () => {
  const USER = '0x886b748C1000000000000000000000000000AAAA';

  afterEach(() => jest.restoreAllMocks());

  it('returns 0n for a fresh EOA (eth_getCode == "0x"), does NOT throw', async () => {
    const svc = makeService({ [USER.toLowerCase()]: '0x' }, {});
    await expect(svc.readNonce(56, USER)).resolves.toBe(0n);
  });

  it('returns 0n even when getCode returns lowercase-empty variants', async () => {
    const svc = makeService({ [USER.toLowerCase()]: '0x0' }, {});
    await expect(svc.readNonce(56, USER)).resolves.toBe(0n);
  });

  it('returns nonce when address has EIP-7702 delegation code', async () => {
    const svc = makeService(
      { [USER.toLowerCase()]: '0xef01001234567890123456789012345678901234567890' },
      { [USER.toLowerCase()]: 5n },
    );
    await expect(svc.readNonce(56, USER)).resolves.toBe(5n);
  });

  it('throws typed CHAIN_RPC_UNAVAILABLE (not GASLESS_INVALID_REQUEST) when code exists but nonce() reverts', async () => {
    const svc = makeService(
      { [USER.toLowerCase()]: '0xef01001234567890123456789012345678901234567890' },
      { [USER.toLowerCase()]: new Error('call reverted') },
    );
    await expect(svc.readNonce(56, USER)).rejects.toMatchObject({
      errorInfo: expect.objectContaining({ code: 20002 }),
    });
  });
});

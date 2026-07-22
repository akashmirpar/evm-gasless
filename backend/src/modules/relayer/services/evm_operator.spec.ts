import { ConfigService } from '@nestjs/config';

import { EvmExecutorService } from './evm_executor.service';

// Standard BIP-39 test vector (Hardhat default). Not a real key.
const TEST_MN = 'test test test test test test test test test test test junk';
const EVM_60_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // m/44'/60'/0'/0/0
// Hardhat account 0 raw key → same address as TEST_MN index 0.
const RAW_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function config(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function service(map: Record<string, string>): EvmExecutorService {
  // chainConfig + rpc are unused by operatorWallet resolution.
  return new EvmExecutorService({} as never, {} as never, config(map));
}
// operatorWallet is a private getter — reach it for the test.
const wallet = (svc: EvmExecutorService) => (svc as unknown as { operatorWallet: { address: string } }).operatorWallet;

describe('EvmExecutorService operator resolution', () => {
  it('derives from OPERATOR_MNEMONIC at m/44\'/60\'/0\'/0/{index}', () => {
    expect(wallet(service({ OPERATOR_MNEMONIC: TEST_MN, OPERATOR_MNEMONIC_INDEX: '0' })).address).toBe(EVM_60_0);
  });

  it('falls back to OPERATOR_PRIVATE_KEY only when no mnemonic (declared-but-unset "" handled)', () => {
    expect(wallet(service({ OPERATOR_MNEMONIC: '', OPERATOR_PRIVATE_KEY: RAW_PK })).address).toBe(EVM_60_0);
  });

  it('throws a clear error when no seed is configured', () => {
    expect(() => wallet(service({ OPERATOR_MNEMONIC: '', OPERATOR_PRIVATE_KEY: '' }))).toThrow(/operator wallet unset/);
  });

  it('rejects a non-integer OPERATOR_MNEMONIC_INDEX with a clear message', () => {
    expect(() => wallet(service({ OPERATOR_MNEMONIC: TEST_MN, OPERATOR_MNEMONIC_INDEX: 'abc' }))).toThrow(
      /OPERATOR_MNEMONIC_INDEX must be a non-negative integer/,
    );
  });

  it('caches the resolved wallet (same instance across accesses)', () => {
    const svc = service({ OPERATOR_MNEMONIC: TEST_MN });
    expect(wallet(svc)).toBe(wallet(svc));
  });
});

import { ConfigService } from '@nestjs/config';
import { HDNodeWallet } from 'ethers';

import { SolanaWalletService } from 'src/modules/solana/services/solana_wallet.service';

// Lives under test/e2e (not src/**/*.spec.ts) only because it loads
// @solana/web3.js, whose rpc-websockets ESM dep the unit ts-jest config can't
// transpile. It needs NO running backend — pure key derivation + mock config.

// Standard BIP-39 test vector (Hardhat default). Not a real key.
const TEST_MN = 'test test test test test test test test test test test junk';
// Deterministic derivations of TEST_MN:
const EVM_60_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // m/44'/60'/0'/0/0
const SOL_501_0 = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96'; // m/44'/501'/0'/0'
const SOL_501_5 = '7EeV8eiRuGoR8bFHCjdCRGQd1RM5sR2dAkdiTEtC9ko7'; // m/44'/501'/5'/0'

/** ConfigService stub. Declared-but-unset YAML keys resolve to '' (never
 * undefined), exactly like yaml_reader's expandVars — the case the Critical hinged on. */
function config(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe('unified operator derivation', () => {
  it('one mnemonic yields the expected EVM and Solana operator addresses', () => {
    expect(HDNodeWallet.fromPhrase(TEST_MN, undefined, `m/44'/60'/0'/0/0`).address).toBe(EVM_60_0);
    expect(SolanaWalletService.fromMnemonic(TEST_MN, 0).publicKey.toBase58()).toBe(SOL_501_0);
  });

  it('OPERATOR_MNEMONIC drives the Solana operator (index via OPERATOR_MNEMONIC_INDEX)', () => {
    const svc = new SolanaWalletService(config({ OPERATOR_MNEMONIC: TEST_MN, OPERATOR_MNEMONIC_INDEX: '5' }));
    expect(svc.getOperatorKeypair().publicKey.toBase58()).toBe(SOL_501_5);
  });

  it('REGRESSION: an unset OPERATOR_MNEMONIC ("") still falls through to legacy SOLANA_OPERATOR_MNEMONIC, NOT the TEST wallet', () => {
    // Before the fix, `'' ?? SOLANA_OPERATOR_MNEMONIC` returned '' and silently
    // routed the mainnet operator to TEST_MNEMONIC.
    const svc = new SolanaWalletService(
      config({
        OPERATOR_MNEMONIC: '',
        OPERATOR_MNEMONIC_INDEX: '',
        SOLANA_OPERATOR_MNEMONIC: TEST_MN,
        SOLANA_OPERATOR_ACCOUNT_INDEX: '5',
        TEST_MNEMONIC: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      }),
    );
    expect(svc.getOperatorKeypair().publicKey.toBase58()).toBe(SOL_501_5);
  });

  it('fails fast in production when no operator seed is configured', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const svc = new SolanaWalletService(config({ OPERATOR_MNEMONIC: '', SOLANA_OPERATOR_MNEMONIC: '', SOLANA_OPERATOR_PRIVATE_KEY: '' }));
      expect(() => svc.getOperatorKeypair()).toThrow(/refusing the TEST_MNEMONIC fallback in production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('dev/test: falls back to TEST_MNEMONIC only when no operator seed is set', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const svc = new SolanaWalletService(config({ OPERATOR_MNEMONIC: '', TEST_MNEMONIC: TEST_MN, TEST_SOLANA_ACCOUNT_INDEX: '0' }));
      expect(svc.getOperatorKeypair().publicKey.toBase58()).toBe(SOL_501_0);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

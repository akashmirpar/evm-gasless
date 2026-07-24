import { ConfigService } from '@nestjs/config';
import { HDNodeWallet } from 'ethers';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { __resetSecretCache } from 'src/config/secret_reader';
import { __resetConfigCache, loadConfig } from 'src/config/yaml_reader';
import { EvmExecutorService } from 'src/modules/relayer/services/evm_executor.service';
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

  it('REGRESSION: OPERATOR_MNEMONIC wins over a stale legacy SOLANA_OPERATOR_PRIVATE_KEY (unified seed authoritative, matches EVM precedence)', () => {
    // base58 secret of the "abandon…" mnemonic at 501/0 — a DIFFERENT operator.
    const STALE_PK = '27npWoNE4HfmLeQo1TyWcW7NEA28qnsnDK7kcttDQEWrCWnro83HMJ97rMmpvYYZRwDAvG4KRuB7hTBacvwD7bgi';
    const svc = new SolanaWalletService(
      config({ OPERATOR_MNEMONIC: TEST_MN, OPERATOR_MNEMONIC_INDEX: '0', SOLANA_OPERATOR_PRIVATE_KEY: STALE_PK }),
    );
    // Must derive from OPERATOR_MNEMONIC, NOT the stale legacy key.
    expect(svc.getOperatorKeypair().publicKey.toBase58()).toBe(SOL_501_0);
    expect(svc.getOperatorKeypair().publicKey.toBase58()).not.toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });

  it('REGRESSION: unified path uses OPERATOR_MNEMONIC_INDEX only, ignoring a stale SOLANA_OPERATOR_ACCOUNT_INDEX', () => {
    const svc = new SolanaWalletService(
      config({ OPERATOR_MNEMONIC: TEST_MN, OPERATOR_MNEMONIC_INDEX: '0', SOLANA_OPERATOR_ACCOUNT_INDEX: '5' }),
    );
    // Index 0 (from OPERATOR_MNEMONIC_INDEX), not 5 (stale SOLANA_OPERATOR_ACCOUNT_INDEX).
    expect(svc.getOperatorKeypair().publicKey.toBase58()).toBe(SOL_501_0);
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

/**
 * The card's integration test: boot the REAL loader from a mnemonic-only secret
 * file plus config.yaml, and assert both operator addresses come out right.
 * Everything above stubs ConfigService, so nothing else verifies that the yaml +
 * secret resolution actually reaches the derivation code.
 */
describe('operator derivation through the real config loader', () => {
  const originalEnvFile = process.env.GASLESS_ENV_FILE;
  const originalMnemonic = process.env.OPERATOR_MNEMONIC;
  let secretFile: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'gasless-operator-'));
    secretFile = join(dir, 'secrets.env');
    // Mnemonic-only: every other value must come from config.yaml.
    writeFileSync(secretFile, `OPERATOR_MNEMONIC=${TEST_MN}\nOPERATOR_MNEMONIC_INDEX=0\n`, { mode: 0o600 });
    process.env.GASLESS_ENV_FILE = secretFile;
    delete process.env.OPERATOR_MNEMONIC;
    __resetSecretCache();
    __resetConfigCache();
  });

  afterAll(() => {
    if (originalEnvFile === undefined) delete process.env.GASLESS_ENV_FILE;
    else process.env.GASLESS_ENV_FILE = originalEnvFile;
    if (originalMnemonic !== undefined) process.env.OPERATOR_MNEMONIC = originalMnemonic;
    rmSync(join(secretFile, '..'), { recursive: true, force: true });
    __resetSecretCache();
    __resetConfigCache();
  });

  it('resolves the mnemonic from the secret file into the merged config map', () => {
    expect(loadConfig().OPERATOR_MNEMONIC).toBe(TEST_MN);
  });

  it('derives the Solana operator that the loader supplied', () => {
    const merged = loadConfig();
    const svc = new SolanaWalletService({ get: (k: string) => merged[k] } as unknown as ConfigService);
    expect(svc.getOperatorKeypair().publicKey.toBase58()).toBe(SOL_501_0);
  });

  it('derives the EVM operator that the loader supplied', () => {
    const merged = loadConfig();
    const executor = Object.create(EvmExecutorService.prototype) as {
      config: ConfigService;
      cachedOperator: null;
      readonly operatorWallet: { address: string };
    };
    executor.config = { get: (k: string) => merged[k] } as unknown as ConfigService;
    executor.cachedOperator = null;
    expect(executor.operatorWallet.address).toBe(EVM_60_0);
  });

  it('keeps the mnemonic out of process.env — it is resolved through the config map only', () => {
    loadConfig();
    expect(process.env.OPERATOR_MNEMONIC).toBeUndefined();
    // A non-secret knob from the same file/YAML is still mirrored.
    expect(process.env.SOLANA_MODE_DEFAULT).toBeDefined();
  });
});

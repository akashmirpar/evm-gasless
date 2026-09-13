import { ConfigService } from '@nestjs/config';
import { HDNodeWallet } from 'ethers';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { __resetSecretCache } from 'src/config/secret_reader';
import { __resetConfigCache, loadConfig } from 'src/config/yaml_reader';
import { EvmExecutorService } from 'src/modules/relayer/services/evm_executor.service';

// Needs NO running backend — pure key derivation + the real config loader.

// Standard BIP-39 test vector (Hardhat default). Not a real key.
const TEST_MN = 'test test test test test test test test test test test junk';
const EVM_60_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // m/44'/60'/0'/0/0

describe('operator derivation', () => {
  it('the mnemonic yields the expected EVM operator address', () => {
    expect(HDNodeWallet.fromPhrase(TEST_MN, undefined, `m/44'/60'/0'/0/0`).address).toBe(EVM_60_0);
  });
});

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
  });
});

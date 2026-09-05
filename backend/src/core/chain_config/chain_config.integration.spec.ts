import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import { ConfigService } from '@nestjs/config';

import { __resetSecretCache } from '../../config/secret_reader';
import { __resetConfigCache, yamlReader } from '../../config/yaml_reader';
import { ChainConfigService } from './chain_config.service';

// Boots ChainConfigService against the REAL committed backend/config.yaml +
// chains/deployed.json — a typo in the `chains:` block would fail here instead
// of only at live boot. No DB, no network (RPC endpoints aren't dialed).
const CONFIG_YAML = join(__dirname, '..', '..', '..', 'config.yaml');
const DEPLOYED_JSON = join(__dirname, '..', '..', '..', '..', 'chains', 'deployed.json');

function config(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe('ChainConfigService — real config.yaml', () => {
  it('loads the five committed chains and merges EVM delegate addresses from deployed.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gasless-cfg-int-'));
    const emptySecrets = join(dir, 'empty.env');
    writeFileSync(emptySecrets, '');
    process.env.GASLESS_ENV_FILE = emptySecrets;
    __resetConfigCache();
    __resetSecretCache();
    yamlReader(CONFIG_YAML);

    const svc = new ChainConfigService(
      config({
        DEPLOYED_JSON_PATH: DEPLOYED_JSON,
        GASLESS_TREASURY_ADDRESS: '0x0000000000000000000000000000000000000001',
        GASLESS_SOLANA_TREASURY_ADDRESS: 'So11111111111111111111111111111111111111112',
      }),
    );
    svc.load();

    const ids = svc.all().map((c) => c.chainId).sort((a, b) => a - b);
    expect(ids).toEqual([-2002, -2000, 56, 8453, 42161]);

    // EVM chains have a delegate address merged from deployed.json.
    for (const evm of [56, 8453, 42161]) {
      expect(svc.get(evm).delegateContractAddress).toMatch(/^0x[0-9a-f]{40}$/);
    }
    // Every chain resolved at least one usable RPC URL (ANKR key unset → public fallback).
    for (const c of svc.all()) {
      expect(c.rpcUrls.length).toBeGreaterThan(0);
      expect(c.rpcUrls.every((u) => !u.includes('${'))).toBe(true);
    }
    // BSC accepts USDT as a direct fee token.
    expect(svc.get(56).acceptedFeeTokenAddresses).toContain('0x55d398326f99059ff775485246999027b3197955');

    delete process.env.GASLESS_ENV_FILE;
  });
});

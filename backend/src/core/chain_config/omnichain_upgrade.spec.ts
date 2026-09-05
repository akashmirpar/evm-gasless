import { readFileSync, readdirSync, statSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join, resolve } from 'path';

import {
  CHAIN_ID_SOLANA_MAINNET,
  CHAIN_ID_SOLANA_DEVNET,
  ChainErrorKinds,
  NetworkType,
  canonicalizeAddress,
  isChainError,
  isSolana,
  networkTypeOf,
} from '@getomnichain/omnichain';

/**
 * Pins the @getomnichain/omnichain upgrade contract: the Solana chain id moved
 * from the retired -100/-102 to the package's canonical -2000/-2002, chain
 * typing/addressing comes from the package, and no legacy id survives anywhere.
 */
const CONFIG_YAML = resolve(__dirname, '..', '..', '..', 'config.yaml');

describe('omnichain upgrade — Solana chain id + typing come from the package', () => {
  it('uses the package canonical Solana ids (-2000 mainnet, -2002 devnet)', () => {
    expect(CHAIN_ID_SOLANA_MAINNET).toBe(-2000);
    expect(CHAIN_ID_SOLANA_DEVNET).toBe(-2002);
  });

  it('resolves Solana typing from the package static family set (mainnet + devnet)', () => {
    expect(networkTypeOf(CHAIN_ID_SOLANA_MAINNET)).toBe(NetworkType.SOLANA);
    expect(networkTypeOf(CHAIN_ID_SOLANA_DEVNET)).toBe(NetworkType.SOLANA);
    expect(isSolana(CHAIN_ID_SOLANA_MAINNET)).toBe(true);
    expect(isSolana(CHAIN_ID_SOLANA_DEVNET)).toBe(true);
    expect(networkTypeOf(56)).toBe(NetworkType.EVM);
  });

  it('the retired -100 is NOT a Solana chain and throws ChainNotSupported (no legacy)', () => {
    expect(isSolana(-100)).toBe(false);
    expect(isSolana(-102)).toBe(false);
    try {
      networkTypeOf(-100);
      throw new Error('expected networkTypeOf(-100) to throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.ChainNotSupported)).toBe(true);
    }
  });

  it('addresses are canonicalized through the package per family', () => {
    // EVM lowercases; Solana base58 is returned as-is (case-sensitive).
    expect(canonicalizeAddress(56, '0x000000000000000000000000000000000000dEaD'))
      .toBe('0x000000000000000000000000000000000000dead');
    expect(canonicalizeAddress(CHAIN_ID_SOLANA_MAINNET, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'))
      .toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('config.yaml carries the package ids and no retired -100/-102', () => {
    const raw = readFileSync(CONFIG_YAML, 'utf8');
    const yaml = parseYaml(raw) as { chains: Array<{ chainId: number; networkType?: string }> };
    const solanaIds = yaml.chains.filter((c) => c.networkType === 'SOLANA').map((c) => c.chainId).sort((a, b) => a - b);
    // Assert against the package constants so a future id change in the package
    // plus a stale yaml fails here, not just an independent literal check.
    expect(solanaIds).toEqual([CHAIN_ID_SOLANA_DEVNET, CHAIN_ID_SOLANA_MAINNET].sort((a, b) => a - b));
  });

  it('no retired -100/-102 literal survives in config, src, tests, scripts, or .env.example', () => {
    const backendRoot = resolve(__dirname, '..', '..', '..');
    // Docs are excluded on purpose: the integration guide's breaking-change note
    // legitimately *names* the retired -100/-102 to document their removal.
    const roots = [
      resolve(__dirname, '..', '..'), // src
      resolve(backendRoot, 'config.yaml'),
      resolve(backendRoot, 'scripts'),
      resolve(backendRoot, 'test'),
      resolve(backendRoot, '.env.example'),
    ];
    // Files that reference the retired ids ON PURPOSE — comments, human-facing
    // CHAIN_NOT_SUPPORTED error text, and the tests that assert -100 now defers /
    // throws. These document the removal; they don't route on it.
    const allowlist = new Set(
      [
        'src/common/address_field.decorator.ts',
        'src/common/address_field.decorator.spec.ts',
        'src/core/chain_config/chain_config.service.ts',
        'src/core/chain_config/chain_config.load.spec.ts',
        'src/core/chain_config/omnichain_upgrade.spec.ts',
        'src/modules/evm/dto/estimate.dto.spec.ts',
      ].map((r) => resolve(backendRoot, r)),
    );
    // Match a retired id used AS A VALUE — a `-100:SYMBOL` whitelist entry, a
    // `chainId`/`*_CHAIN_ID` assignment, or the id as a call arg / array element /
    // rhs (`(-100`, `[-100`, `,-100`, `= -100`) — not an incidental -100-shaped
    // literal in prose. -101 was never a chain id.
    const legacy = /-10[02]:|(?:chainId|_CHAIN_ID)["'\s:=]+-10[02]\b|[=([,]\s*-10[02]\b/i;
    const offenders: string[] = [];
    const walk = (p: string): void => {
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) return;
      if (st.isDirectory()) {
        if (p.includes('node_modules') || p.endsWith('/dist')) return;
        for (const e of readdirSync(p)) walk(join(p, e));
        return;
      }
      if (!/\.(ts|js|mjs|json|yaml|yml|md|example)$/.test(p) && !p.endsWith('.env.example')) return;
      if (allowlist.has(p)) return;
      if (legacy.test(readFileSync(p, 'utf8'))) offenders.push(p.replace(`${backendRoot}/`, ''));
    };
    for (const r of roots) walk(r);
    expect(offenders).toEqual([]);
  });
});

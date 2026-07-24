import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, parse as parsePath } from 'path';

import { loadChainsConfig } from '../../config/yaml_reader';
import { PlutonException } from '../../common/errors';
import { NetworkType, registerNonEvmChain } from '../../common/utils/network_type';
import { redactRpcUrl } from '../../common/utils/redact_rpc';
import { ChainConfigErrors } from './chain_config.errors';
import { ChainConfig, ChainRegistryShape } from './chain_config.types';

/**
 * Industry-standard sentinel address for native gas tokens (1inch, Rango,
 * Paraswap all use this). Recognized case-insensitively.
 */
export const NATIVE_TOKEN_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export function isNativeSentinel(address: string): boolean {
  return address.trim().toLowerCase() === NATIVE_TOKEN_SENTINEL;
}

@Injectable()
export class ChainConfigService implements OnModuleInit {
  private readonly logger = new Logger(ChainConfigService.name);
  private chains = new Map<number, ChainConfig>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.load();
  }

  load(): void {
    const chains = loadChainsConfig() as ChainRegistryShape['chains'];
    if (chains.length === 0) {
      throw new Error('no chains defined — add a `chains:` section to config.yaml');
    }
    const deployedJsonPath = (this.config.get<string>('DEPLOYED_JSON_PATH')?.trim() || ChainConfigService.findDeployedJson(__dirname));
    this.logger.log(`reading ${chains.length} chains from config.yaml; deployed from ${deployedJsonPath}`);

    const deployedExists = existsSync(deployedJsonPath);
    const deployed: Record<string, string> = deployedExists
      ? (JSON.parse(readFileSync(deployedJsonPath, 'utf8')) as Record<string, string>)
      : {};
    if (!deployedExists) {
      const evmChains = chains.filter((c) => c.networkType !== 'SOLANA').map((c) => `${c.name}(${c.chainId})`);
      this.logger.warn(
        `deployed.json not found at ${deployedJsonPath} — every EVM chain will report 20003 NO_DEPLOYED_CONTRACT: ${evmChains.join(', ')}. ` +
          `Set DEPLOYED_JSON_PATH or run contract/script/deploy.sh.`,
      );
    }

    const evmTreasury = (this.config.get<string>('GASLESS_TREASURY_ADDRESS') ?? '').trim();
    const solanaTreasury = (this.config.get<string>('GASLESS_SOLANA_TREASURY_ADDRESS') ?? '').trim();
    if (!evmTreasury) {
      this.logger.warn('GASLESS_TREASURY_ADDRESS not set — EVM endpoints that need it will fail');
    }

    // Env-var-driven accepted list is retained only for Solana (the whitelist
    // drop lands in a follow-up card there). EVM chains derive their accepted
    // list directly from the yaml chain entry.
    const legacyAcceptedSet = new Set(
      (this.config.get<string>('GASLESS_ACCEPTED_FEE_TOKENS') ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );

    const out = new Map<number, ChainConfig>();
    for (const c of chains) {
      // `chainId`/`nativeDecimals` must be real numbers: a quoted YAML value
      // would key the registry by a string and every get(56) would miss, so the
      // chain would answer 20001 CHAIN_NOT_SUPPORTED for all traffic.
      const chainId = Number(c.chainId);
      if (!Number.isInteger(chainId)) {
        throw new Error(`config.yaml chain "${c.name}": chainId must be an unquoted integer, got ${JSON.stringify(c.chainId)}`);
      }
      const nativeDecimals = Number(c.nativeDecimals);
      if (!Number.isInteger(nativeDecimals) || nativeDecimals < 0) {
        throw new Error(`config.yaml chain "${c.name}": nativeDecimals must be an unquoted non-negative integer, got ${JSON.stringify(c.nativeDecimals)}`);
      }
      if (out.has(chainId)) {
        throw new Error(`config.yaml: duplicate chainId ${chainId} — "${c.name}" collides with "${out.get(chainId)!.name}"`);
      }
      c.chainId = chainId;
      c.nativeDecimals = nativeDecimals;

      const networkType: NetworkType = c.networkType === 'SOLANA' ? NetworkType.SOLANA : NetworkType.EVM;
      if (networkType !== NetworkType.EVM) {
        registerNonEvmChain(chainId, networkType);
      }

      const rpcUrls = (c.rpcUrls ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (rpcUrls.length === 0) {
        throw new Error(`config.yaml chain ${c.chainId} (${c.name}) has no rpcUrls`);
      }

      const isEvm = networkType === NetworkType.EVM;
      const delegateAddress = isEvm
        ? deployed[String(c.chainId)]?.toLowerCase() ?? null
        : null;

      if (isEvm) {
        const parsed = ChainConfigService.parseEvmChain(c, legacyAcceptedSet);
        out.set(c.chainId, {
          chainId: c.chainId,
          name: c.name,
          displayName: c.displayName,
          nativeSymbol: c.nativeSymbol,
          nativeDecimals: c.nativeDecimals,
          networkType,
          rangoChainName: c.rangoChainName,
          rpcUrls,
          tokens: [],
          delegateContractAddress: delegateAddress,
          acceptedFeeTokenAddresses: parsed.acceptedFeeTokenAddresses,
          mainFeeTokenAddress: parsed.mainFeeTokenAddress,
          treasuryAddress: evmTreasury,
        });
      } else {
        const parsed = ChainConfigService.parseSolanaChain(c, legacyAcceptedSet);
        if (parsed.widened) {
          this.logger.warn(
            `chain ${c.name}(${chainId}): GASLESS_ACCEPTED_FEE_TOKENS matched nothing, so ALL ${parsed.tokens.length} registry ` +
              `SPLs are accepted as fee tokens (${parsed.tokens.map((t) => t.symbol).join(', ')}). ` +
              `Set an explicit <chainId>:<SYMBOL> list to narrow this.`,
          );
        }
        out.set(c.chainId, {
          chainId: c.chainId,
          name: c.name,
          displayName: c.displayName,
          nativeSymbol: c.nativeSymbol,
          nativeDecimals: c.nativeDecimals,
          networkType,
          rangoChainName: c.rangoChainName,
          rpcUrls,
          tokens: parsed.tokens,
          delegateContractAddress: delegateAddress,
          acceptedFeeTokenAddresses: parsed.acceptedFeeTokenAddresses,
          mainFeeTokenAddress: parsed.mainFeeTokenAddress,
          treasuryAddress: solanaTreasury,
        });
      }
    }
    this.chains = out;
    this.logger.log(`loaded ${out.size} chains: ${[...out.values()].map((c) => `${c.name}(${c.networkType})`).join(', ')}`);
    // Log the endpoints actually in play (hosts only — the keyed URL carries
    // ${ANKR_API_KEY} in its path) so a silent fallback to the keyless public
    // endpoints is visible at boot rather than as 429s under load.
    for (const c of out.values()) {
      this.logger.log(`chain ${c.name}(${c.chainId}) rpc: ${c.rpcUrls.map(redactRpcUrl).join(', ')}`);
    }
  }

  private static parseEvmChain(
    c: ChainRegistryShape['chains'][number],
    _legacyAcceptedSet: Set<string>,
  ): { acceptedFeeTokenAddresses: string[]; mainFeeTokenAddress: string } {
    const accepted = (c.acceptedFeeTokens ?? []).map((a) => a.trim().toLowerCase()).filter((s) => s.length > 0);
    if (accepted.length === 0) {
      throw new Error(
        `config.yaml: EVM chain ${c.chainId} (${c.name}) missing "acceptedFeeTokens" — this shape is required after the whitelist-drop refactor. See RIN-113.`,
      );
    }
    const main = (c.mainFeeToken ?? '').trim().toLowerCase();
    if (!main) {
      throw new Error(
        `config.yaml: EVM chain ${c.chainId} (${c.name}) missing "mainFeeToken" — required target token for the swap-fee path.`,
      );
    }
    if (!accepted.includes(main)) {
      throw new Error(
        `config.yaml: EVM chain ${c.chainId} (${c.name}) mainFeeToken ${main} is not in acceptedFeeTokens — the swap target must itself be an accepted token to keep the direct-accept path valid for it.`,
      );
    }
    return { acceptedFeeTokenAddresses: accepted, mainFeeTokenAddress: main };
  }

  private static parseSolanaChain(
    c: ChainRegistryShape['chains'][number],
    legacyAcceptedSet: Set<string>,
  ): { tokens: ChainConfig['tokens']; acceptedFeeTokenAddresses: string[]; mainFeeTokenAddress: string; widened: boolean } {
    const tokens = Object.entries(c.tokens ?? {}).map(([symbol, t]) => ({
      symbol,
      address: t.address.trim(),
      decimals: t.decimals,
    }));
    const matches = tokens.filter((t) =>
      legacyAcceptedSet.has(`${c.chainId}:${t.symbol.toLowerCase()}`) ||
      legacyAcceptedSet.has(`${c.chainId}:${t.address.toLowerCase()}`) ||
      legacyAcceptedSet.has(t.address.toLowerCase()),
    );
    const accepted = matches.length > 0 ? matches.map((t) => t.address) : tokens.map((t) => t.address);
    if (accepted.length === 0) {
      throw new Error(
        `config.yaml: Solana chain ${c.chainId} (${c.name}) has no accepted fee tokens — either the tokens map is empty or the ` +
          `GASLESS_ACCEPTED_FEE_TOKENS env var filters everything out. Add at least one accepted SPL to continue.`,
      );
    }
    const main = accepted[0];
    return { tokens, acceptedFeeTokenAddresses: accepted, mainFeeTokenAddress: main, widened: matches.length === 0 };
  }

  get(chainId: number): ChainConfig {
    const c = this.chains.get(chainId);
    if (!c) throw PlutonException(ChainConfigErrors.ChainNotSupported, { chainId });
    return c;
  }

  getOrNull(chainId: number): ChainConfig | null {
    return this.chains.get(chainId) ?? null;
  }

  all(): ChainConfig[] {
    return [...this.chains.values()];
  }

  requireDelegateAddress(chainId: number): string {
    const c = this.get(chainId);
    if (!c.delegateContractAddress) {
      throw PlutonException(ChainConfigErrors.NoDeployedContract, { chainId });
    }
    return c.delegateContractAddress;
  }

  /**
   * @deprecated for EVM — the token whitelist has been dropped and EVM fee
   * tokens are now resolved dynamically via TokenMetadataService. Only Solana
   * still uses this lookup while its whitelist-drop is deferred.
   */
  tokenByAddress(chainId: number, address: string): { symbol: string; address: string; decimals: number } | null {
    const c = this.get(chainId);
    if (c.networkType === NetworkType.SOLANA) {
      const trimmed = address.trim();
      return c.tokens.find((t) => t.address === trimmed) ?? null;
    }
    const lower = address.toLowerCase();
    return c.tokens.find((t) => t.address === lower) ?? null;
  }

  isFeeTokenAccepted(chainId: number, address: string): boolean {
    const c = this.get(chainId);
    if (c.networkType === NetworkType.SOLANA) {
      const trimmed = address.trim();
      return c.acceptedFeeTokenAddresses.includes(trimmed);
    }
    if (isNativeSentinel(address)) return false;
    return c.acceptedFeeTokenAddresses.includes(address.toLowerCase());
  }

  private static findDeployedJson(startDir: string): string {
    const { root } = parsePath(startDir);
    let dir = startDir;
    while (true) {
      const candidate = join(dir, 'chains', 'deployed.json');
      if (existsSync(candidate)) return candidate;
      if (dir === root) {
        return join(startDir, 'chains', 'deployed.json');
      }
      dir = dirname(dir);
    }
  }
}

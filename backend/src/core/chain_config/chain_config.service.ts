import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, parse as parsePath } from 'path';

import { PlutonException } from '../../common/errors';
import { NetworkType, registerNonEvmChain } from '../../common/utils/network_type';
import { ChainConfigErrors } from './chain_config.errors';
import { ChainConfig, ChainsJsonShape } from './chain_config.types';

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

  onModuleInit(): void {
    this.load();
  }

  load(): void {
    const chainsJsonPath = (process.env.CHAINS_JSON_PATH?.trim() || ChainConfigService.findChainsJson(__dirname));
    const deployedJsonPath = (process.env.DEPLOYED_JSON_PATH?.trim() || join(dirname(chainsJsonPath), 'deployed.json'));
    this.logger.log(`reading chains config from ${chainsJsonPath}; deployed from ${deployedJsonPath}`);

    if (!existsSync(chainsJsonPath)) {
      throw new Error(`chains.json not found at ${chainsJsonPath}`);
    }

    const raw = JSON.parse(readFileSync(chainsJsonPath, 'utf8')) as ChainsJsonShape;
    const deployed: Record<string, string> = existsSync(deployedJsonPath)
      ? (JSON.parse(readFileSync(deployedJsonPath, 'utf8')) as Record<string, string>)
      : {};

    const evmTreasury = (process.env.GASLESS_TREASURY_ADDRESS ?? '').trim();
    const solanaTreasury = (process.env.GASLESS_SOLANA_TREASURY_ADDRESS ?? '').trim();
    if (!evmTreasury) {
      this.logger.warn('GASLESS_TREASURY_ADDRESS not set — EVM endpoints that need it will fail');
    }

    // Env-var-driven accepted list is retained only for Solana (the whitelist
    // drop lands in a follow-up card there). EVM chains derive their accepted
    // list directly from chains.json.
    const legacyAcceptedSet = new Set(
      (process.env.GASLESS_ACCEPTED_FEE_TOKENS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );

    const out = new Map<number, ChainConfig>();
    for (const c of raw.chains) {
      const networkType: NetworkType = c.networkType === 'SOLANA' ? NetworkType.SOLANA : NetworkType.EVM;
      if (networkType !== NetworkType.EVM) {
        registerNonEvmChain(c.chainId, networkType);
      }

      const override = (process.env[c.envRpcVar] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const rpcUrls = override.length > 0 ? override : c.defaultRpcs;

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
  }

  private static parseEvmChain(
    c: ChainsJsonShape['chains'][number],
    _legacyAcceptedSet: Set<string>,
  ): { acceptedFeeTokenAddresses: string[]; mainFeeTokenAddress: string } {
    const accepted = (c.acceptedFeeTokens ?? []).map((a) => a.trim().toLowerCase()).filter((s) => s.length > 0);
    if (accepted.length === 0) {
      throw new Error(
        `chains.json: EVM chain ${c.chainId} (${c.name}) missing "acceptedFeeTokens" — this shape is required after the whitelist-drop refactor. See RIN-113.`,
      );
    }
    const main = (c.mainFeeToken ?? '').trim().toLowerCase();
    if (!main) {
      throw new Error(
        `chains.json: EVM chain ${c.chainId} (${c.name}) missing "mainFeeToken" — required target token for the swap-fee path.`,
      );
    }
    if (!accepted.includes(main)) {
      throw new Error(
        `chains.json: EVM chain ${c.chainId} (${c.name}) mainFeeToken ${main} is not in acceptedFeeTokens — the swap target must itself be an accepted token to keep the direct-accept path valid for it.`,
      );
    }
    return { acceptedFeeTokenAddresses: accepted, mainFeeTokenAddress: main };
  }

  private static parseSolanaChain(
    c: ChainsJsonShape['chains'][number],
    legacyAcceptedSet: Set<string>,
  ): { tokens: ChainConfig['tokens']; acceptedFeeTokenAddresses: string[]; mainFeeTokenAddress: string } {
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
    const main = accepted[0] ?? '';
    return { tokens, acceptedFeeTokenAddresses: accepted, mainFeeTokenAddress: main };
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

  private static findChainsJson(startDir: string): string {
    const { root } = parsePath(startDir);
    let dir = startDir;
    while (true) {
      const candidate = join(dir, 'chains', 'chains.json');
      if (existsSync(candidate)) return candidate;
      if (dir === root) {
        throw new Error(`could not find chains/chains.json walking up from ${startDir}; set CHAINS_JSON_PATH`);
      }
      dir = dirname(dir);
    }
  }
}

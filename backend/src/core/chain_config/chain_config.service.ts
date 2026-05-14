import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, parse as parsePath } from 'path';

import { PlutonException } from '../../common/errors';
import { ChainConfigErrors } from './chain_config.errors';
import { ChainConfig, ChainsJsonShape } from './chain_config.types';

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

    const treasury = (process.env.GASLESS_TREASURY_ADDRESS ?? '').trim();
    if (!treasury) {
      this.logger.warn('GASLESS_TREASURY_ADDRESS not set — endpoints that need it will fail');
    }

    const acceptedSet = new Set(
      (process.env.GASLESS_ACCEPTED_FEE_TOKENS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );

    const out = new Map<number, ChainConfig>();
    for (const c of raw.chains) {
      const override = (process.env[c.envRpcVar] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // If the operator configured private/paid RPCs, use ONLY those — public
      // defaults from chains.json are skipped to avoid hitting their rate
      // limits or pulling in unreliable endpoints. Defaults apply only when
      // the env override is empty.
      const rpcUrls = override.length > 0 ? override : c.defaultRpcs;

      const tokens = Object.entries(c.tokens).map(([symbol, t]) => ({
        symbol,
        address: t.address.toLowerCase(),
        decimals: t.decimals,
      }));

      const chainAcceptedTokens = tokens
        .filter((t) =>
          acceptedSet.has(`${c.chainId}:${t.symbol.toLowerCase()}`) ||
          acceptedSet.has(`${c.chainId}:${t.address.toLowerCase()}`) ||
          acceptedSet.has(t.address.toLowerCase()),
        )
        .map((t) => t.address);

      out.set(c.chainId, {
        chainId: c.chainId,
        name: c.name,
        displayName: c.displayName,
        nativeSymbol: c.nativeSymbol,
        nativeDecimals: c.nativeDecimals,
        rangoChainName: c.rangoChainName,
        rpcUrls,
        tokens,
        delegateContractAddress: deployed[String(c.chainId)]?.toLowerCase() ?? null,
        acceptedFeeTokenAddresses: chainAcceptedTokens.length > 0 ? chainAcceptedTokens : tokens.map((t) => t.address),
        treasuryAddress: treasury,
      });
    }
    this.chains = out;
    this.logger.log(`loaded ${out.size} chains: ${[...out.values()].map((c) => c.name).join(', ')}`);
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

  tokenByAddress(chainId: number, address: string): { symbol: string; address: string; decimals: number } | null {
    const c = this.get(chainId);
    const lower = address.toLowerCase();
    return c.tokens.find((t) => t.address === lower) ?? null;
  }

  isFeeTokenAccepted(chainId: number, address: string): boolean {
    const c = this.get(chainId);
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

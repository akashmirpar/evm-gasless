import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, parse as parsePath } from 'path';

import { loadChainsConfig } from '../../config/yaml_reader';
import { PlutonException } from '../../common/errors';
import { NetworkType } from '@getomnichain/omnichain';
import { redactRpcUrl } from '../../common/utils/redact_rpc';
import { ChainConfigErrors } from './chain_config.errors';
import { ChainConfig, ChainRegistryShape } from './chain_config.types';

// Native-gas-token sentinel lives in one place (common/native_token) so the DTO
// decorator and this service can't drift. Imported for internal use and
// re-exported for the modules that already import it from here.
import { NATIVE_TOKEN_SENTINEL, isNativeSentinel } from '../../common/native_token';
export { NATIVE_TOKEN_SENTINEL, isNativeSentinel };

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
      const names = chains.map((c) => `${c.name}(${c.chainId})`);
      this.logger.warn(
        `deployed.json not found at ${deployedJsonPath} — every chain will report 20003 NO_DEPLOYED_CONTRACT: ${names.join(', ')}. ` +
          `Set DEPLOYED_JSON_PATH or run contract/script/deploy.sh.`,
      );
    }

    const treasury = (this.config.get<string>('GASLESS_TREASURY_ADDRESS') ?? '').trim();
    if (!treasury) {
      this.logger.warn('GASLESS_TREASURY_ADDRESS not set — accepted-fee requests will fail (no fallback)');
    }

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

      const rpcUrls = (c.rpcUrls ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (rpcUrls.length === 0) {
        throw new Error(`config.yaml chain ${c.chainId} (${c.name}) has no rpcUrls`);
      }

      const parsed = ChainConfigService.parseChain(c);
      out.set(c.chainId, {
        chainId: c.chainId,
        name: c.name,
        displayName: c.displayName,
        nativeSymbol: c.nativeSymbol,
        nativeDecimals: c.nativeDecimals,
        networkType: NetworkType.EVM,
        rangoChainName: c.rangoChainName,
        rpcUrls,
        tokens: [],
        delegateContractAddress: deployed[String(c.chainId)]?.toLowerCase() ?? null,
        acceptedFeeTokenAddresses: parsed.acceptedFeeTokenAddresses,
        mainFeeTokenAddress: parsed.mainFeeTokenAddress,
        treasuryAddress: treasury,
      });
    }

    this.chains = out;
    this.logger.log(`loaded ${out.size} chains: ${[...out.values()].map((c) => `${c.name}(${c.chainId})`).join(', ')}`);
    // Log the endpoints actually in play (hosts only — the keyed URL carries
    // ${ANKR_API_KEY} in its path) so a silent fallback to the keyless public
    // endpoints is visible at boot rather than as 429s under load.
    for (const c of out.values()) {
      this.logger.log(`chain ${c.name}(${c.chainId}) rpc: ${c.rpcUrls.map(redactRpcUrl).join(', ')}`);
    }
  }

  private static parseChain(
    c: ChainRegistryShape['chains'][number],
  ): { acceptedFeeTokenAddresses: string[]; mainFeeTokenAddress: string } {
    const accepted = (c.acceptedFeeTokens ?? []).map((a) => a.trim().toLowerCase()).filter((s) => s.length > 0);
    if (accepted.length === 0) {
      throw new Error(
        `config.yaml: chain ${c.chainId} (${c.name}) missing "acceptedFeeTokens" — this shape is required after the whitelist-drop refactor. See RIN-113.`,
      );
    }
    const main = (c.mainFeeToken ?? '').trim().toLowerCase();
    if (!main) {
      throw new Error(
        `config.yaml: chain ${c.chainId} (${c.name}) missing "mainFeeToken" — required target token for the swap-fee path.`,
      );
    }
    if (!accepted.includes(main)) {
      throw new Error(
        `config.yaml: chain ${c.chainId} (${c.name}) mainFeeToken ${main} is not in acceptedFeeTokens — the swap target must itself be an accepted token to keep the direct-accept path valid for it.`,
      );
    }
    return { acceptedFeeTokenAddresses: accepted, mainFeeTokenAddress: main };
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
   * @deprecated the token whitelist has been dropped and fee tokens are resolved
   * dynamically via TokenMetadataService.
   */
  tokenByAddress(chainId: number, address: string): { symbol: string; address: string; decimals: number } | null {
    const c = this.get(chainId);
    const lower = address.toLowerCase();
    return c.tokens.find((t) => t.address === lower) ?? null;
  }

  isFeeTokenAccepted(chainId: number, address: string): boolean {
    const c = this.get(chainId);
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

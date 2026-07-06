import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { Contract } from 'ethers';

import { PlutonException } from '../../common/errors';
import { ChainConfigService, isNativeSentinel } from '../chain_config/chain_config.service';
import { GaslessErrors } from '../../modules/gasless/gasless.errors';
import { NetworkType } from '../../common/utils/network_type';
import { RpcService } from '../rpc/rpc.service';

const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const ERC20_SYMBOL_ABI = ['function symbol() view returns (string)'];

export interface TokenMetadata {
  address: string;
  decimals: number;
  symbol: string;
}

@Injectable()
export class TokenMetadataService {
  private readonly logger = new Logger(TokenMetadataService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly rpc: RpcService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    this.ttlMs = Number(process.env.GASLESS_TOKEN_METADATA_TTL_SECONDS ?? '86400') * 1_000;
  }

  async getDecimals(chainId: number, address: string): Promise<number> {
    const cfg = this.chainConfig.get(chainId);
    if (cfg.networkType !== NetworkType.EVM) {
      throw new Error(`TokenMetadataService.getDecimals only supports EVM chains (got chainId=${chainId})`);
    }
    if (isNativeSentinel(address)) return cfg.nativeDecimals;

    const lower = address.trim().toLowerCase();
    const cacheKey = `token:decimals:${chainId}:${lower}`;
    try {
      const cached = await this.cache.get<number>(cacheKey);
      if (typeof cached === 'number' && Number.isInteger(cached) && cached >= 0 && cached <= 255) {
        return cached;
      }
    } catch (err) {
      this.logger.warn(`decimals cache read failed for ${cacheKey}: ${(err as Error)?.message ?? err}`);
    }

    let decimals: number;
    try {
      decimals = await this.rpc.withFallback(chainId, async (provider) => {
        const contract = new Contract(lower, ERC20_DECIMALS_ABI, provider);
        const raw = await contract.decimals();
        return Number(raw);
      });
    } catch (err) {
      throw PlutonException(GaslessErrors.FeeTokenUnreadable, err);
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw PlutonException(GaslessErrors.FeeTokenUnreadable, {
        reason: `ERC20.decimals() returned non-uint8 value ${decimals}`,
      });
    }

    try {
      await this.cache.set(cacheKey, decimals, this.ttlMs);
    } catch (err) {
      this.logger.warn(`decimals cache write failed for ${cacheKey}: ${(err as Error)?.message ?? err}`);
    }
    return decimals;
  }

  /**
   * Best-effort symbol lookup for use in Rango token descriptors. Not
   * throw-worthy — Rango indexes by address and treats the symbol as a display
   * hint. On any error we return '?' and let Rango do its own lookup.
   */
  async getSymbolBestEffort(chainId: number, address: string): Promise<string> {
    const cfg = this.chainConfig.get(chainId);
    if (isNativeSentinel(address)) return cfg.nativeSymbol;

    const lower = address.trim().toLowerCase();
    const cacheKey = `token:symbol:${chainId}:${lower}`;
    try {
      const cached = await this.cache.get<string>(cacheKey);
      if (typeof cached === 'string' && cached.length > 0) return cached;
    } catch {
      // ignore
    }
    try {
      const sym = await this.rpc.withFallback(chainId, async (provider) => {
        const contract = new Contract(lower, ERC20_SYMBOL_ABI, provider);
        return String(await contract.symbol());
      });
      try {
        await this.cache.set(cacheKey, sym, this.ttlMs);
      } catch {
        // ignore
      }
      return sym;
    } catch {
      return '?';
    }
  }
}

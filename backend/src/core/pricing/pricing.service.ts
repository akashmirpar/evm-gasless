import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../common/errors';
import { GaslessErrors } from '../../common/errors/gasless.errors';
import { ChainConfigService, isNativeSentinel, NATIVE_TOKEN_SENTINEL } from '../chain_config/chain_config.service';
import { PriceBlob, priceKey, TokenPriceEntry } from './pricing.types';

export const PRICE_BLOB_CACHE_KEY = 'gasless:prices';

function readPositiveInt(envValue: string | undefined, fallback: number): number {
  const n = Number((envValue ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Validate a parsed Redis value has the PriceBlob shape the age guard relies on. */
function asPriceBlob(value: unknown): PriceBlob | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt)) return null;
  if (typeof v.tokens !== 'object' || v.tokens === null) return null;
  return value as PriceBlob;
}

/**
 * Serves USD prices for fee estimation. Prices are produced by
 * `TokenPriceRefreshJob` (Rango `/basic/meta`, every few minutes) and held in
 * Redis as a single blob, mirrored into an in-process copy so request-path
 * reads never parse the blob. A blob older than `GASLESS_PRICE_MAX_AGE_SECONDS`
 * is treated as unusable so a wedged refresh job can't silently under-price.
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  private readonly maxAgeMs: number;
  private inMemory: PriceBlob | null = null;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly chainConfig: ChainConfigService,
  ) {
    this.maxAgeMs = readPositiveInt(process.env.GASLESS_PRICE_MAX_AGE_SECONDS, 900) * 1000;
  }

  /** Overwrite the current snapshot in Redis and in memory. Called by the refresh job. */
  async publish(blob: PriceBlob): Promise<void> {
    this.inMemory = blob;
    // Pin Redis retention to the staleness window. Omitting the ttl would let
    // the global CacheModule default (REDIS_DEFAULT_TTL_SECONDS, ~300s) expire
    // the blob well before maxAge, so a peer instance restarting mid-window
    // would find no blob at all. A blob older than maxAge is unusable anyway
    // (entry() rejects it), so expiring it exactly at maxAge loses nothing.
    await this.cache.set(PRICE_BLOB_CACHE_KEY, JSON.stringify(blob), this.maxAgeMs);
  }

  /**
   * USD price for a token (native sentinel resolves to the chain's native
   * asset). Throws `GaslessErrors.PriceUnavailable` if the blob is missing,
   * stale, or has no entry for the token.
   */
  async priceUsd(chainId: number, addressOrNative: string): Promise<number> {
    return (await this.entry(chainId, addressOrNative)).usdPrice;
  }

  /**
   * Convert a native-asset amount (base units) into fee-token base units at
   * current USD prices. Used by the fixed-fee path and the no-loss ceiling
   * check. Both the native asset and the fee token must have a fresh price.
   */
  async nativeToFeeToken(chainId: number, feeTokenAddressOrNative: string, nativeBaseUnits: BigNumber): Promise<BigNumber> {
    const native = await this.entry(chainId, NATIVE_TOKEN_SENTINEL);
    const feeToken = await this.entry(chainId, feeTokenAddressOrNative);

    const nativeHuman = nativeBaseUnits.dividedBy(new BigNumber(10).pow(native.decimals));
    const usdValue = nativeHuman.multipliedBy(native.usdPrice);
    const feeHuman = usdValue.dividedBy(feeToken.usdPrice);
    return feeHuman.multipliedBy(new BigNumber(10).pow(feeToken.decimals)).integerValue(BigNumber.ROUND_CEIL);
  }

  /** USD value (human units) of a token amount given in base units. For fiat rendering. */
  async toUsd(chainId: number, addressOrNative: string, baseUnits: BigNumber): Promise<BigNumber> {
    const entry = await this.entry(chainId, addressOrNative);
    return baseUnits.dividedBy(new BigNumber(10).pow(entry.decimals)).multipliedBy(entry.usdPrice);
  }

  private isStale(blob: PriceBlob): boolean {
    return Date.now() - blob.updatedAt > this.maxAgeMs;
  }

  private async entry(chainId: number, addressOrNative: string): Promise<TokenPriceEntry> {
    const blob = await this.load();
    if (!blob || this.isStale(blob)) {
      throw PlutonException(GaslessErrors.PriceUnavailable, {
        reason: blob ? `blob stale by ${Math.round((Date.now() - blob.updatedAt) / 1000)}s` : 'no price blob loaded',
      });
    }
    const cfg = this.chainConfig.get(chainId);
    const key = isNativeSentinel(addressOrNative)
      ? priceKey(cfg.rangoChainName, null)
      : priceKey(cfg.rangoChainName, addressOrNative);
    const entry = blob.tokens[key];
    if (!entry || !Number.isFinite(entry.usdPrice) || entry.usdPrice <= 0) {
      throw PlutonException(GaslessErrors.PriceUnavailable, { reason: `no usable price for ${key}` });
    }
    return entry;
  }

  private async load(): Promise<PriceBlob | null> {
    // Fresh in-memory copy wins — no Redis hit on the happy path (the refresh
    // job publishes far more often than maxAge). Only when our copy is missing
    // or stale do we consult Redis, so a peer instance that kept the blob fresh
    // can self-heal this instance when its own refresh job has wedged.
    if (this.inMemory && !this.isStale(this.inMemory)) return this.inMemory;

    let raw: string | null | undefined;
    try {
      raw = await this.cache.get<string>(PRICE_BLOB_CACHE_KEY);
    } catch (err) {
      // Redis unreachable — transient. Fall back to whatever we have in memory
      // (entry() enforces the age guard on it).
      this.logger.warn(`price blob Redis read failed: ${(err as Error)?.message ?? err}`);
      return this.inMemory;
    }
    if (!raw) return this.inMemory;

    try {
      const parsed = JSON.parse(raw) as unknown;
      const fromRedis = asPriceBlob(parsed);
      if (!fromRedis) {
        // Shape is wrong (bad updatedAt or tokens) — a non-numeric updatedAt
        // would make isStale() return false and defeat the age guard, so
        // discard rather than adopt. Keep the last good in-memory copy.
        this.logger.error('price blob from Redis has an invalid shape; discarding');
      } else if (!this.inMemory || fromRedis.updatedAt > this.inMemory.updatedAt) {
        this.inMemory = fromRedis;
      }
    } catch (err) {
      // A corrupt blob is data corruption, not transient unavailability.
      this.logger.error(`price blob JSON parse failed (corrupt): ${(err as Error)?.message ?? err}`);
    }
    return this.inMemory;
  }
}

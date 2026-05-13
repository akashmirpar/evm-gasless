import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import type { Cache } from 'cache-manager';

import { OperationInput } from '../domain/operation';

export interface CachedRequest {
  chainId: number;
  userAddress: string;
  delegateContractAddress: string;
  feeTokenAddress: string;
  feeAmount: string;
  operations: OperationInput[];
  atomicGroupStart: number;
  batchNonce: string;
  digest: string;
  createdAt: number;
}

@Injectable()
export class GaslessCacheService {
  private readonly ttlMs: number;

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {
    this.ttlMs = Number(process.env.GASLESS_CREATE_TTL_SECONDS ?? '300') * 1_000;
  }

  async put(requestId: string, data: CachedRequest): Promise<void> {
    await this.cache.set(this.key(requestId), data, this.ttlMs);
  }

  async get(requestId: string): Promise<CachedRequest | null> {
    const v = await this.cache.get<CachedRequest>(this.key(requestId));
    return v ?? null;
  }

  async drop(requestId: string): Promise<void> {
    await this.cache.del(this.key(requestId));
  }

  private key(requestId: string): string {
    return `gasless:req:${requestId}`;
  }
}

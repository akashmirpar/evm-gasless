import { Injectable } from '@nestjs/common';
import { EvmChain } from '@getomnichain/omnichain';

import { RpcService } from '../../../core/rpc/rpc.service';

// `GaslessDelegate.nonce` is storage slot 2 of the delegated EOA (see
// contract/test: test_nonceStorageSlotIsPinned). Read the slot rather than
// calling `nonce()` through whatever code the EOA currently carries: the batch
// nonce lives in the EOA's storage and survives re-delegation, so a user moving
// from an earlier delegate address to the current one keeps their nonce. Calling
// `nonce()` — or assuming 0 when the EOA points elsewhere — signs a batch the
// contract rejects with InvalidNonce.
const NONCE_STORAGE_SLOT = 2n;

@Injectable()
export class DelegateStateService {
  constructor(private readonly rpc: RpcService) {}

  /**
   * Queries every configured RPC and returns the highest reported nonce.
   * Public RPC pools (publicnode, etc.) load-balance across nodes that may lag
   * by a block or two; taking the max gives the most up-to-date safe view —
   * the nonce is monotonic, so the max is never higher than truth.
   */
  async readNonce(chainId: number, userAddress: string): Promise<bigint> {
    const chains = this.rpc.evmChainsFor(chainId);
    const results = await Promise.allSettled(chains.map((chain) => this.readSlot(chain, userAddress)));
    let max = 0n;
    let anySucceeded = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        anySucceeded = true;
        if (r.value > max) max = r.value;
      }
    }
    if (anySucceeded) return max;

    // Every endpoint failed: go through the seam so the exhausted-fallback
    // surfaces as the typed CHAIN_RPC_UNAVAILABLE error.
    return this.rpc.withChain(chainId, (chain) => this.readSlot(chain, userAddress));
  }

  private async readSlot(chain: EvmChain, userAddress: string): Promise<bigint> {
    const raw = await chain.getProvider().getStorage(userAddress, NONCE_STORAGE_SLOT);
    return BigInt(raw);
  }
}

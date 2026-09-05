import { Injectable } from '@nestjs/common';
import { Interface } from 'ethers';
import { EvmChain } from '@getomnichain/omnichain';

import { PlutonException } from '../../../common/errors';
import { ErrorCodes } from '../../../common/errors/codes';
import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
import { RpcService } from '../../../core/rpc/rpc.service';

// Pure ABI codec (calldata encode / result decode is computation, not a chain
// interaction — the RPC call itself goes through the omnichain EvmChain).
const DELEGATE_NONCE_IFACE = new Interface(['function nonce() view returns (uint256)']);

@Injectable()
export class DelegateStateService {
  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly rpc: RpcService,
  ) {}

  /**
   * Queries every configured RPC and returns the highest reported nonce.
   * Public RPC pools (publicnode, etc.) load-balance across nodes that may lag
   * by a block or two; taking the max gives the most up-to-date safe view —
   * the chain's nonce is monotonic, so the max is never higher than truth.
   */
  async readNonce(chainId: number, userAddress: string): Promise<bigint> {
    const expectedDelegate = this.chainConfig.requireDelegateAddress(chainId);
    const chains = this.rpc.evmChainsFor(chainId);
    const results = await Promise.allSettled(chains.map((chain) => this.readNonceFrom(chain, userAddress, expectedDelegate)));
    let max = 0n;
    let anySucceeded = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        anySucceeded = true;
        if (r.value > max) max = r.value;
      }
    }
    if (anySucceeded) return max;

    // Every endpoint failed: fall back through the seam's error handling so a
    // genuine "delegated but nonce() reverted" surfaces as a domain error.
    return this.rpc.withChain(chainId, async (chain) => {
      const delegation = await chain.getDelegation(userAddress);
      if (!isDelegatedToUs(delegation, expectedDelegate)) return 0n;
      try {
        return await this.callNonce(chain, userAddress);
      } catch (err) {
        throw PlutonException(
          {
            code: ErrorCodes.CHAIN_RPC_UNAVAILABLE,
            httpCode: 502,
            message: `GaslessDelegate nonce read failed for ${userAddress} on chain ${chainId}. Address is delegated to our contract but nonce() call reverted — likely a transient RPC issue.`,
            service: 'DelegateState',
          },
          err,
        );
      }
    });
  }

  private async readNonceFrom(chain: EvmChain, userAddress: string, expectedDelegate: string): Promise<bigint> {
    const delegation = await chain.getDelegation(userAddress);
    if (!isDelegatedToUs(delegation, expectedDelegate)) return 0n;
    return this.callNonce(chain, userAddress);
  }

  private async callNonce(chain: EvmChain, userAddress: string): Promise<bigint> {
    const { result } = await chain.call({ to: userAddress, data: DELEGATE_NONCE_IFACE.encodeFunctionData('nonce', []) });
    const [nonce] = DELEGATE_NONCE_IFACE.decodeFunctionResult('nonce', result ?? '0x');
    return BigInt(nonce);
  }
}

function isDelegatedToUs(delegation: { delegate: string } | null, expectedDelegate: string): boolean {
  if (!delegation) return false;
  return delegation.delegate.toLowerCase() === expectedDelegate.toLowerCase();
}

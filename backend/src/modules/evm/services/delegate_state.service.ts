import { Injectable } from '@nestjs/common';
import { Contract } from 'ethers';

import { PlutonException } from '../../../common/errors';
import { ErrorCodes } from '../../../common/errors/codes';
import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
import { RpcService } from '../../../core/rpc/rpc.service';

const DELEGATE_NONCE_ABI = ['function nonce() view returns (uint256)'];

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
    const cfg = this.chainConfig.get(chainId);
    const expectedDelegate = this.chainConfig.requireDelegateAddress(chainId);
    const results = await Promise.allSettled(
      cfg.rpcUrls.map((url) => this.readNonceFrom(url, userAddress, chainId, expectedDelegate)),
    );
    let max = 0n;
    let anySucceeded = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        anySucceeded = true;
        if (r.value > max) max = r.value;
      }
    }
    if (!anySucceeded) {
      return this.rpc.withFallback(chainId, async (provider) => {
        const code = await provider.getCode(userAddress);
        if (!isDelegatedToUs(code, expectedDelegate)) return 0n;
        const contract = new Contract(userAddress, DELEGATE_NONCE_ABI, provider);
        try {
          return BigInt(await contract.nonce());
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
    return max;
  }

  private async readNonceFrom(rpcUrl: string, userAddress: string, chainId: number, expectedDelegate: string): Promise<bigint> {
    const provider = this.rpc.providerFor(chainId, rpcUrl);
    try {
      const code = await provider.getCode(userAddress);
      if (!isDelegatedToUs(code, expectedDelegate)) return 0n;
      const contract = new Contract(userAddress, DELEGATE_NONCE_ABI, provider);
      const n = await contract.nonce();
      return BigInt(n);
    } finally {
      provider.destroy();
    }
  }
}

function isDelegatedToUs(code: string, expectedDelegate: string): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  const lc = code.toLowerCase();
  if (!lc.startsWith('0xef0100') || lc.length < 48) return false;
  return '0x' + lc.slice(8) === expectedDelegate.toLowerCase();
}

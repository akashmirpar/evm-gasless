import { Injectable } from '@nestjs/common';
import { Contract } from 'ethers';

import { RpcService } from '../../../core/rpc/rpc.service';

const DELEGATE_NONCE_ABI = ['function nonce() view returns (uint256)'];

@Injectable()
export class DelegateStateService {
  constructor(private readonly rpc: RpcService) {}

  async readNonce(chainId: number, userAddress: string): Promise<bigint> {
    return this.rpc.withFallback(chainId, async (provider) => {
      const contract = new Contract(userAddress, DELEGATE_NONCE_ABI, provider);
      try {
        const n = await contract.nonce();
        return BigInt(n);
      } catch {
        return 0n;
      }
    });
  }
}

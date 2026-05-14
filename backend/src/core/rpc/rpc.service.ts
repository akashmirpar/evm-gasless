import { Injectable } from '@nestjs/common';
import { JsonRpcProvider, Network } from 'ethers';

import { PlutonException } from '../../common/errors';
import { ErrorCodes } from '../../common/errors/codes';
import { ChainConfigService } from '../chain_config/chain_config.service';

@Injectable()
export class RpcService {
  constructor(private readonly chainConfig: ChainConfigService) {}

  providerFor(chainId: number, rpcUrl: string): JsonRpcProvider {
    const network = Network.from(chainId);
    return new JsonRpcProvider(rpcUrl, network);
  }

  async withFallback<T>(chainId: number, op: (provider: JsonRpcProvider, url: string) => Promise<T>): Promise<T> {
    const cfg = this.chainConfig.get(chainId);
    if (cfg.rpcUrls.length === 0) {
      throw PlutonException({
        code: ErrorCodes.CHAIN_RPC_UNAVAILABLE,
        httpCode: 503,
        message: `No RPC configured for chain ${chainId}`,
        service: 'Rpc',
      });
    }
    const errors: unknown[] = [];
    for (const url of cfg.rpcUrls) {
      const provider = this.providerFor(chainId, url);
      try {
        const out = await op(provider, url);
        return out;
      } catch (err) {
        errors.push(err);
        provider.destroy();
      }
    }
    throw PlutonException(
      {
        code: ErrorCodes.CHAIN_RPC_UNAVAILABLE,
        httpCode: 503,
        message: `All RPCs failed for chain ${chainId}`,
        service: 'Rpc',
      },
      errors,
    );
  }
}

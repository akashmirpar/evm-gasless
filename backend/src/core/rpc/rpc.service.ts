import { Injectable } from '@nestjs/common';
import { JsonRpcProvider, Network } from 'ethers';

import { PlutonException, isPlutonException } from '../../common/errors';
import { ErrorCodes } from '../../common/errors/codes';
import { redactRpcUrl, scrubRpcSecrets } from '../../common/utils/redact_rpc';
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
    const attempts: Array<{ url: string; error: string }> = [];
    for (const url of cfg.rpcUrls) {
      const provider = this.providerFor(chainId, url);
      try {
        const out = await op(provider, url);
        return out;
      } catch (err) {
        if (isPlutonException(err)) throw err;
        attempts.push({ url: redactRpcUrl(url), error: scrubRpcSecrets((err as Error)?.message ?? String(err), [url]) });
        provider.destroy();
      }
    }
    throw PlutonException(
      {
        code: ErrorCodes.CHAIN_RPC_UNAVAILABLE,
        httpCode: 503,
        message: `All RPCs failed for chain ${chainId} (tried ${attempts.length} URL(s))`,
        service: 'Rpc',
      },
      attempts,
    );
  }
}

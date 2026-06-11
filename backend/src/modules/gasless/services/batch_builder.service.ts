import { Injectable } from '@nestjs/common';
import { Interface } from 'ethers';

import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
import { RangoClient } from '../../rango/rango.client';
import { UserOpDto } from '../dto/estimate.dto';
import { OperationInput } from '../domain/operation';
import { FeeEstimate } from './fee_estimator.service';

const ERC20_IFACE = new Interface([
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
]);

export interface BuiltBatch {
  operations: OperationInput[];
  atomicGroupStart: number;
}

@Injectable()
export class BatchBuilderService {
  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly rango: RangoClient,
  ) {}

  async build(chainId: number, userAddress: string, estimate: FeeEstimate, userOps: UserOpDto[]): Promise<BuiltBatch> {
    const cfg = this.chainConfig.get(chainId);
    const mustSucceed: OperationInput[] = [];

    if (estimate.acceptedFeeToken) {
      mustSucceed.push({
        to: estimate.feeTokenAddress,
        value: '0',
        data: ERC20_IFACE.encodeFunctionData('transfer', [cfg.treasuryAddress, estimate.feeAmountInFeeToken.toFixed()]),
      });
    } else {
      const swap = await this.rango.swap({
        from: this.tokenOf(cfg, estimate.feeTokenAddress),
        to: this.tokenOf(cfg, estimate.acceptedFeeTokenAddress),
        amount: estimate.feeAmountInFeeToken.toFixed(),
        userAddress,
        recipientAddress: cfg.treasuryAddress,
        slippage: Number(process.env.GASLESS_RANGO_SLIPPAGE ?? '0.5'),
      });

      if (!swap.evmTransaction) {
        throw new Error('Expected EVM swap response from Rango but got non-EVM');
      }
      const evmTx = swap.evmTransaction;
      if (evmTx.approveTo && evmTx.approveData) {
        mustSucceed.push({ to: evmTx.approveTo, value: '0', data: evmTx.approveData });
      }
      mustSucceed.push({ to: evmTx.to, value: evmTx.value ?? '0', data: evmTx.data });
    }

    const userOperations: OperationInput[] = userOps.map((o) => ({ to: o.to, value: o.value, data: o.data }));

    return {
      operations: [...mustSucceed, ...userOperations],
      atomicGroupStart: mustSucceed.length,
    };
  }

  private tokenOf(cfg: ReturnType<ChainConfigService['get']>, addressLower: string) {
    const t = cfg.tokens.find((x) => x.address === addressLower);
    if (!t) {
      throw new Error(`Token ${addressLower} not configured on chain ${cfg.chainId}`);
    }
    return { chainName: cfg.rangoChainName, address: t.address, symbol: t.symbol, decimals: t.decimals };
  }
}

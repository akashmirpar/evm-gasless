import { Injectable } from '@nestjs/common';
import { Interface, ZeroAddress } from 'ethers';

import { PlutonException } from '../../../common/errors';
import { ChainConfigService, isNativeSentinel, NATIVE_TOKEN_SENTINEL } from '../../../core/chain_config/chain_config.service';
import { TokenMetadataService } from '../../../core/token_metadata/token_metadata.service';
import { RangoClient } from '../../rango/rango.client';
import { GaslessErrors } from '../gasless.errors';
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
    private readonly tokenMetadata: TokenMetadataService,
  ) {}

  async build(chainId: number, userAddress: string, estimate: FeeEstimate, userOps: UserOpDto[]): Promise<BuiltBatch> {
    const cfg = this.chainConfig.get(chainId);
    const mustSucceed: OperationInput[] = [];

    if (estimate.acceptedFeeToken) {
      // Direct-accept ERC-20 (native never lands here — native is never in
      // acceptedFeeTokens per current config). Transfer to treasury.
      mustSucceed.push({
        to: estimate.feeTokenAddress,
        value: '0',
        data: ERC20_IFACE.encodeFunctionData('transfer', [cfg.treasuryAddress, estimate.feeAmountInFeeToken.toFixed()]),
      });
    } else {
      // Swap-fee path: input = native (sentinel) OR arbitrary ERC-20; output =
      // mainFeeToken → treasury. Rango picks the DEX and returns the tx.
      const fromToken = estimate.isNativeFeeToken
        ? { chainName: cfg.rangoChainName, address: null as string | null, symbol: cfg.nativeSymbol, decimals: cfg.nativeDecimals }
        : await this.rangoTokenFor(chainId, cfg, estimate.feeTokenAddress);
      const toToken = await this.rangoTokenFor(chainId, cfg, estimate.acceptedFeeTokenAddress);

      const swap = await this.rango.swap({
        from: fromToken,
        to: toToken,
        amount: estimate.feeAmountInFeeToken.toFixed(),
        userAddress,
        recipientAddress: cfg.treasuryAddress,
        slippage: Number(process.env.GASLESS_RANGO_SLIPPAGE ?? '5.0'),
      });

      if (!swap.evmTransaction) {
        throw new Error('Expected EVM swap response from Rango but got non-EVM');
      }
      const evmTx = swap.evmTransaction;

      // Native input: no approve needed; the swap tx pulls ETH via `value`.
      // The Rango-returned approveTo/approveData is only present for ERC-20
      // inputs, but we defensively skip approve for the native branch even if
      // Rango were to include one (a bad-actor swap would be caught by
      // amountOutMin at execution).
      if (!estimate.isNativeFeeToken && evmTx.approveTo && evmTx.approveData) {
        mustSucceed.push({ to: evmTx.approveTo, value: '0', data: evmTx.approveData });
      }
      mustSucceed.push({ to: evmTx.to, value: evmTx.value ?? '0', data: evmTx.data });

      // Defensive sanity: for the native path, the swap op's value MUST be
      // non-zero and MUST equal the fee amount we quoted. If Rango returned an
      // approve for a native input, or value ≠ feeAmount, we refuse the batch
      // rather than silently miss-charge the user.
      const swapOp = mustSucceed[mustSucceed.length - 1];
      const swapValue = BigInt(swapOp.value || '0');
      if (estimate.isNativeFeeToken) {
        if (swapValue !== BigInt(estimate.feeAmountInFeeToken.toFixed())) {
          throw PlutonException(GaslessErrors.FeeTokenNotAcceptedAndNoRoute, {
            reason: `Rango native-swap tx value (${swapValue}) does not match quoted fee (${estimate.feeAmountInFeeToken.toFixed()})`,
          });
        }
      } else {
        // Symmetric guard for the ERC-20 input path: the swap op must NOT
        // pull native value out of the user's EOA. A compromised or
        // misbehaving Rango response with `value > 0` here would drain the
        // user's ETH silently, since the operation is in the must-succeed
        // group. Refuse before the user ever signs.
        if (swapValue !== 0n) {
          throw PlutonException(GaslessErrors.FeeTokenNotAcceptedAndNoRoute, {
            reason: `Rango ERC-20-swap tx unexpectedly requires native value=${swapValue} (must be 0 for token-in swaps)`,
          });
        }
      }
    }

    const userOperations: OperationInput[] = userOps.map((o) => ({ to: o.to, value: o.value, data: o.data }));

    return {
      operations: [...mustSucceed, ...userOperations],
      atomicGroupStart: mustSucceed.length,
    };
  }

  private async rangoTokenFor(
    chainId: number,
    cfg: ReturnType<ChainConfigService['get']>,
    address: string,
  ): Promise<{ chainName: string; address: string; symbol: string; decimals: number }> {
    if (isNativeSentinel(address) || address === ZeroAddress) {
      throw new Error(`rangoTokenFor called with non-ERC-20 address ${address}`);
    }
    const decimals = await this.tokenMetadata.getDecimals(chainId, address);
    const symbol = await this.tokenMetadata.getSymbolBestEffort(chainId, address);
    return { chainName: cfg.rangoChainName, address, symbol, decimals };
  }
}

// Retain export for backward compatibility with imports/tests that reference
// the sentinel via this module.
export { NATIVE_TOKEN_SENTINEL };

import { Injectable, Logger } from '@nestjs/common';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../../common/errors';
import { ErrorCodes } from '../../../common/errors/codes';
import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
import { RpcService } from '../../../core/rpc/rpc.service';
import { RangoClient } from '../../rango/rango.client';
import { GaslessErrors } from '../gasless.errors';
import { UserOpDto } from '../dto/estimate.dto';

export interface FeeEstimate {
  feeTokenAddress: string;
  feeAmountInFeeToken: BigNumber;
  acceptedFeeToken: boolean;
  gasUnits: bigint;
  nativeFeeAmount: BigNumber;
  swapRoute?: { inputToken: string; outputToken: string; outputAmount: BigNumber };
  acceptedFeeTokenAddress: string;
}

@Injectable()
export class FeeEstimatorService {
  private readonly logger = new Logger(FeeEstimatorService.name);
  private readonly baseFeeMarkupPercent: number;
  private readonly defaultGasUnits: bigint;

  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly rpc: RpcService,
    private readonly rango: RangoClient,
  ) {
    this.baseFeeMarkupPercent = Number(process.env.GASLESS_BASE_FEE_MARKUP_PERCENT ?? '15');
    this.defaultGasUnits = BigInt(process.env.GASLESS_DEFAULT_GAS_UNITS ?? '1500000');
  }

  async estimate(chainId: number, userAddress: string, feeTokenAddress: string, ops: UserOpDto[]): Promise<FeeEstimate> {
    const cfg = this.chainConfig.get(chainId);

    const gasUnits = await this.estimateGasUnits(chainId, userAddress, ops);
    const gasPriceWei = await this.rpc.withFallback(chainId, async (provider) => {
      const fee = await provider.getFeeData();
      const candidate = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
      return BigInt(candidate);
    });

    const nativeFeeWeiRaw = new BigNumber((gasUnits * gasPriceWei).toString());
    const nativeFeeWei = nativeFeeWeiRaw
      .multipliedBy(100 + this.baseFeeMarkupPercent)
      .dividedBy(100)
      .integerValue(BigNumber.ROUND_CEIL);

    const feeTokenLower = feeTokenAddress.toLowerCase();
    const accepted = cfg.acceptedFeeTokenAddresses.includes(feeTokenLower);

    if (accepted) {
      const result = await this.convertNativeToAccepted(chainId, cfg, feeTokenLower, nativeFeeWei);
      return { ...result, gasUnits, nativeFeeAmount: nativeFeeWei, acceptedFeeToken: true, acceptedFeeTokenAddress: feeTokenLower };
    }

    const acceptedAddress = cfg.acceptedFeeTokenAddresses[0];
    if (!acceptedAddress) {
      throw PlutonException(GaslessErrors.FeeTokenNotAcceptedAndNoRoute, { reason: 'no accepted fee token configured for chain' });
    }

    const acceptedResult = await this.convertNativeToAccepted(chainId, cfg, acceptedAddress, nativeFeeWei);
    const feeAmountInAccepted = acceptedResult.feeAmountInFeeToken;

    // We want: "what is feeAmountInAccepted of the accepted token worth in the user's fee token?"
    // Rango's quote interprets `amount` as INPUT-side units, so we invert the direction.
    // The actual on-chain swap goes user→accepted; the inverse quote here just prices the conversion.
    const inverseQuote = await this.rango.quote({
      from: this.tokenOf(cfg, acceptedAddress),
      to: this.tokenOf(cfg, feeTokenLower),
      amount: feeAmountInAccepted.toFixed(),
    });
    if (inverseQuote.outputAmount.isZero()) {
      throw PlutonException(GaslessErrors.FeeTokenNotAcceptedAndNoRoute, { reason: 'inverse quote returned zero output' });
    }
    // Buffer for the actual swap (user→accepted) slippage. Round-trip slippage doubles the configured one-side slippage.
    const slippagePct = Number(process.env.GASLESS_RANGO_SLIPPAGE ?? '0.5') * 2;
    const feeAmountInFeeToken = inverseQuote.outputAmount
      .multipliedBy(100 + slippagePct)
      .dividedBy(100)
      .integerValue(BigNumber.ROUND_CEIL);

    return {
      feeTokenAddress: feeTokenLower,
      feeAmountInFeeToken,
      acceptedFeeToken: false,
      gasUnits,
      nativeFeeAmount: nativeFeeWei,
      swapRoute: { inputToken: feeTokenLower, outputToken: acceptedAddress, outputAmount: feeAmountInAccepted },
      acceptedFeeTokenAddress: acceptedAddress,
    };
  }

  private async convertNativeToAccepted(
    chainId: number,
    cfg: ReturnType<ChainConfigService['get']>,
    acceptedAddress: string,
    nativeFeeWei: BigNumber,
  ): Promise<{ feeTokenAddress: string; feeAmountInFeeToken: BigNumber }> {
    const quote = await this.rango.quote({
      from: { chainName: cfg.rangoChainName, address: null, symbol: cfg.nativeSymbol, decimals: cfg.nativeDecimals },
      to: this.tokenOf(cfg, acceptedAddress),
      amount: nativeFeeWei.toFixed(),
    });
    return { feeTokenAddress: acceptedAddress, feeAmountInFeeToken: quote.outputAmount };
  }

  private async estimateGasUnits(chainId: number, userAddress: string, ops: UserOpDto[]): Promise<bigint> {
    try {
      const estimated = await this.rpc.withFallback(chainId, async (provider) => {
        let total = 0n;
        for (const op of ops) {
          const g = await provider.estimateGas({
            from: userAddress,
            to: op.to,
            value: BigInt(op.value),
            data: op.data,
          });
          total += BigInt(g);
        }
        return total;
      });
      if (estimated === 0n) return this.defaultGasUnits;
      const buffered = (estimated * 12n) / 10n;
      return buffered;
    } catch (err) {
      this.logger.warn(`gas estimation failed; falling back to default: ${(err as Error)?.message ?? err}`);
      return this.defaultGasUnits;
    }
  }

  private tokenOf(cfg: ReturnType<ChainConfigService['get']>, addressLower: string) {
    const t = cfg.tokens.find((x) => x.address === addressLower);
    if (!t) {
      throw PlutonException(
        {
          code: ErrorCodes.CHAIN_TOKEN_NOT_FOUND,
          httpCode: 400,
          message: `Token ${addressLower} not configured on chain ${cfg.chainId}`,
          service: 'FeeEstimator',
        },
      );
    }
    return { chainName: cfg.rangoChainName, address: t.address, symbol: t.symbol, decimals: t.decimals };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../../common/errors';
import { ChainConfigService, isNativeSentinel, NATIVE_TOKEN_SENTINEL } from '../../../core/chain_config/chain_config.service';
import { RpcService } from '../../../core/rpc/rpc.service';
import { TokenMetadataService } from '../../../core/token_metadata/token_metadata.service';
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
  isNativeFeeToken: boolean;
}

interface RangoTokenDescriptor {
  chainName: string;
  address: string | null;
  symbol: string;
  decimals: number;
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
    private readonly tokenMetadata: TokenMetadataService,
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

    const isNative = isNativeSentinel(feeTokenAddress);
    const feeTokenLowerOrSentinel = isNative ? NATIVE_TOKEN_SENTINEL : feeTokenAddress.toLowerCase();
    const accepted = !isNative && cfg.acceptedFeeTokenAddresses.includes(feeTokenLowerOrSentinel);

    // Path 1: accepted ERC-20 fee token (USDT/USDC/etc). Direct-accept: convert
    // the native gas cost into the fee token via a forward Rango quote.
    if (accepted) {
      const acceptedToken = await this.rangoTokenFor(chainId, cfg, feeTokenLowerOrSentinel);
      const nativeToken = this.rangoNativeToken(cfg);
      const quote = await this.rango.quote({ from: nativeToken, to: acceptedToken, amount: nativeFeeWei.toFixed() });
      return {
        feeTokenAddress: feeTokenLowerOrSentinel,
        feeAmountInFeeToken: quote.outputAmount,
        acceptedFeeToken: true,
        gasUnits,
        nativeFeeAmount: nativeFeeWei,
        acceptedFeeTokenAddress: feeTokenLowerOrSentinel,
        isNativeFeeToken: false,
      };
    }

    // Paths 2 & 3: user pays in an unaccepted fee token — either native
    // (sentinel) OR an arbitrary ERC-20. We swap it into mainFeeToken on the
    // treasury via Rango's `/basic/swap` (batch builder consumes that tx).
    // Inverse-quote pattern for exact-out sizing.
    const acceptedTarget = cfg.mainFeeTokenAddress;
    const acceptedTargetToken = await this.rangoTokenFor(chainId, cfg, acceptedTarget);
    const nativeToken = this.rangoNativeToken(cfg);
    const nativeToAccepted = await this.rango.quote({ from: nativeToken, to: acceptedTargetToken, amount: nativeFeeWei.toFixed() });
    const feeAmountInAccepted = nativeToAccepted.outputAmount;

    const inputToken: RangoTokenDescriptor = isNative
      ? nativeToken
      : await this.rangoTokenFor(chainId, cfg, feeTokenLowerOrSentinel);

    const inverseQuote = await this.rango.quote({
      from: acceptedTargetToken,
      to: inputToken,
      amount: feeAmountInAccepted.toFixed(),
    });
    if (inverseQuote.outputAmount.isZero()) {
      throw PlutonException(GaslessErrors.FeeTokenNotAcceptedAndNoRoute, { reason: 'inverse quote returned zero output' });
    }

    const slippagePct = Number(process.env.GASLESS_RANGO_SLIPPAGE ?? '0.5') * 2;
    const feeAmountInFeeToken = inverseQuote.outputAmount
      .multipliedBy(100 + slippagePct)
      .dividedBy(100)
      .integerValue(BigNumber.ROUND_CEIL);

    return {
      feeTokenAddress: feeTokenLowerOrSentinel,
      feeAmountInFeeToken,
      acceptedFeeToken: false,
      gasUnits,
      nativeFeeAmount: nativeFeeWei,
      swapRoute: { inputToken: feeTokenLowerOrSentinel, outputToken: acceptedTarget, outputAmount: feeAmountInAccepted },
      acceptedFeeTokenAddress: acceptedTarget,
      isNativeFeeToken: isNative,
    };
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

  private rangoNativeToken(cfg: ReturnType<ChainConfigService['get']>): RangoTokenDescriptor {
    return { chainName: cfg.rangoChainName, address: null, symbol: cfg.nativeSymbol, decimals: cfg.nativeDecimals };
  }

  private async rangoTokenFor(
    chainId: number,
    cfg: ReturnType<ChainConfigService['get']>,
    addressLower: string,
  ): Promise<RangoTokenDescriptor> {
    const decimals = await this.tokenMetadata.getDecimals(chainId, addressLower);
    const symbol = await this.tokenMetadata.getSymbolBestEffort(chainId, addressLower);
    return { chainName: cfg.rangoChainName, address: addressLower, symbol, decimals };
  }
}

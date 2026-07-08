import { Injectable, Logger } from '@nestjs/common';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../../common/errors';
import { ErrorCodes } from '../../../common/errors/codes';
import { ChainConfigService, isNativeSentinel, NATIVE_TOKEN_SENTINEL } from '../../../core/chain_config/chain_config.service';
import { RpcService } from '../../../core/rpc/rpc.service';
import { TokenMetadataService } from '../../../core/token_metadata/token_metadata.service';
import { RangoClient } from '../../rango/rango.client';
import { GaslessErrors } from '../gasless.errors';
import { UserOpDto } from '../dto/estimate.dto';

function readPositiveNumber(envValue: string | undefined, fallback: number, name: string): number {
  const raw = (envValue ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid ${name}: expected a positive finite number, got "${raw}"`);
  }
  return n;
}

function readPositiveBigInt(envValue: string | undefined, fallback: bigint, name: string): bigint {
  const raw = (envValue ?? '').trim();
  if (raw === '') return fallback;
  try {
    const v = BigInt(raw);
    if (v < 0n) throw new Error('negative');
    return v;
  } catch {
    throw new Error(`invalid ${name}: expected a non-negative integer, got "${raw}"`);
  }
}

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
    this.baseFeeMarkupPercent = readPositiveNumber(process.env.GASLESS_BASE_FEE_MARKUP_PERCENT, 15, 'GASLESS_BASE_FEE_MARKUP_PERCENT');
    this.defaultGasUnits = readPositiveBigInt(process.env.GASLESS_DEFAULT_GAS_UNITS, 1_500_000n, 'GASLESS_DEFAULT_GAS_UNITS');
  }

  async estimate(chainId: number, userAddress: string, feeTokenAddress: string, ops: UserOpDto[]): Promise<FeeEstimate> {
    const cfg = this.chainConfig.get(chainId);

    const gasUnits = await this.estimateGasUnits(chainId, userAddress, ops);
    const gasPriceWei = await this.rpc.withFallback(chainId, async (provider) => {
      const fee = await provider.getFeeData();
      const candidate = fee.maxFeePerGas ?? fee.gasPrice;
      if (candidate === null || candidate === undefined || BigInt(candidate) === 0n) {
        throw PlutonException(
          {
            code: ErrorCodes.CHAIN_GAS_ESTIMATION_FAILED,
            httpCode: 502,
            message: `Chain ${chainId} RPC returned no usable gas price (both maxFeePerGas and gasPrice were null/zero). Refusing to fall back to a hardcoded default because the operator would silently under-quote the fee under load.`,
            service: 'FeeEstimator',
          },
        );
      }
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

    const slippagePct = readPositiveNumber(process.env.GASLESS_RANGO_SLIPPAGE, 5.0, 'GASLESS_RANGO_SLIPPAGE') * 2;
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
    let estimated: bigint;
    try {
      estimated = await this.rpc.withFallback(chainId, async (provider) => {
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
    } catch (err) {
      // Fresh 7702 EOAs can't be estimateGas'd against their own future
      // delegate code, so a revert here is expected on the golden path. Log
      // at ERROR level with the specific reason so integrator debugging
      // isn't a scavenger hunt, then fall back to the configured default.
      this.logger.error(
        `estimateGas failed for chain=${chainId} user=${userAddress} ops=${ops.length}; using default ${this.defaultGasUnits}. ` +
          `reason: ${(err as Error)?.message ?? err}`,
      );
      return this.defaultGasUnits;
    }
    if (estimated === 0n) {
      // Every op reporting 0 gas is an RPC anomaly (not a "this batch is
      // free" signal). Throwing lets the caller see 20005 rather than a
      // silent under-quote at defaultGasUnits.
      throw PlutonException(
        {
          code: ErrorCodes.CHAIN_GAS_ESTIMATION_FAILED,
          httpCode: 502,
          message: `Chain ${chainId} RPC returned 0 total gas across ${ops.length} ops — RPC anomaly, refusing to substitute default.`,
          service: 'FeeEstimator',
        },
      );
    }
    return (estimated * 12n) / 10n;
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

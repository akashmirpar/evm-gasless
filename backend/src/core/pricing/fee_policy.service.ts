import { Injectable, Logger } from '@nestjs/common';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../common/errors';
import { GaslessErrors } from '../../common/errors/gasless.errors';
import { PricingService } from './pricing.service';

export type FeeMode = 'fixed' | 'bps';

export interface FiatFields {
  feeUsd?: string;
  estimatedNativeCostUsd?: string;
}

/** Parsed `GASLESS_FEE_PROFIT` entry keyed by `${chainId}:${addrOrSymbolLower}`. */
function parseProfitConfig(raw: string | undefined): Map<string, BigNumber> {
  const out = new Map<string, BigNumber>();
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [chainId, key, amount] = entry.split(':').map((s) => s.trim());
    const value = new BigNumber(amount ?? '');
    if (!chainId || !key || value.isNaN() || value.isNegative()) {
      throw new Error(`invalid GASLESS_FEE_PROFIT entry "${entry}" — expected chainId:TOKEN:amount`);
    }
    out.set(`${chainId}:${key.toLowerCase()}`, value);
  }
  return out;
}

/**
 * Centralizes fee sizing so EVM and Solana estimators share one policy:
 *   - `bps` mode (default): keep the existing markup-then-convert path (this
 *     service returns null so the estimator's own logic runs unchanged).
 *   - `fixed` mode: price the simulated network cost into the settlement token
 *     via the price feed and add a per-token profit — no dependence on the
 *     token's own Rango quote for the cost portion.
 * Plus a mode-independent no-loss ceiling guard and best-effort fiat fields.
 */
@Injectable()
export class FeePolicyService {
  private readonly logger = new Logger(FeePolicyService.name);
  private readonly feeMode: FeeMode;
  private readonly profit: Map<string, BigNumber>;
  private readonly priorityHeadroomBps: number;
  private readonly noLossCheckEnabled: boolean;

  constructor(private readonly pricing: PricingService) {
    const modeRaw = (process.env.GASLESS_FEE_MODE ?? 'bps').trim().toLowerCase();
    this.feeMode = modeRaw === 'fixed' ? 'fixed' : 'bps';
    this.profit = parseProfitConfig(process.env.GASLESS_FEE_PROFIT);
    const headroom = Number(process.env.GASLESS_PRIORITY_HEADROOM_BPS ?? '3000');
    this.priorityHeadroomBps = Number.isFinite(headroom) && headroom >= 0 ? headroom : 3000;
    const noLoss = (process.env.GASLESS_NO_LOSS_CHECK ?? 'false').trim().toLowerCase();
    this.noLossCheckEnabled = noLoss === 'true' || noLoss === '1';

    // Foot-gun guard: in bps mode the settlement amount is the cost marked up by
    // GASLESS_BASE_FEE_MARKUP_PERCENT, while the no-loss ceiling is cost × (1 +
    // headroom). If the markup is below the headroom, the guard refuses (40015)
    // essentially every quote. That is fail-closed (never under-charge), but
    // surprising, so warn loudly at boot rather than only at request time.
    if (this.noLossCheckEnabled && this.feeMode === 'bps') {
      const markupPct = Number(process.env.GASLESS_BASE_FEE_MARKUP_PERCENT ?? '15');
      if (Number.isFinite(markupPct) && markupPct < this.priorityHeadroomBps / 100) {
        this.logger.warn(
          `GASLESS_NO_LOSS_CHECK is on in bps mode but markup ${markupPct}% < headroom ` +
            `${this.priorityHeadroomBps / 100}% — the no-loss guard will reject most quotes (40015). ` +
            `Raise GASLESS_BASE_FEE_MARKUP_PERCENT to >= headroom, or switch to GASLESS_FEE_MODE=fixed.`,
        );
      }
    }
  }

  mode(): FeeMode {
    return this.feeMode;
  }

  /**
   * Fixed-mode settlement-token amount (base units): the network cost priced
   * into the settlement token plus the configured per-token profit. Returns
   * `null` in bps mode so the caller keeps its existing markup path.
   */
  async fixedSettlementAmount(
    chainId: number,
    settlementTokenAddressOrNative: string,
    settlementSymbol: string,
    settlementDecimals: number,
    simulatedNativeBaseUnits: BigNumber,
  ): Promise<BigNumber | null> {
    if (this.feeMode !== 'fixed') return null;
    const costPart = await this.pricing.nativeToFeeToken(chainId, settlementTokenAddressOrNative, simulatedNativeBaseUnits);
    const profitHuman = this.profitFor(chainId, settlementTokenAddressOrNative, settlementSymbol);
    const profitBase = profitHuman.multipliedBy(new BigNumber(10).pow(settlementDecimals)).integerValue(BigNumber.ROUND_CEIL);
    return costPart.plus(profitBase);
  }

  /**
   * No-loss ceiling guard. Throws `FeeBelowMaxNetworkCost` when the settlement
   * amount is worth less than the ceiling network cost (simulated + priority
   * headroom) priced into the settlement token. No-op when disabled.
   */
  async assertCoversNetworkCost(
    chainId: number,
    settlementTokenAddressOrNative: string,
    settlementAmountBaseUnits: BigNumber,
    simulatedNativeBaseUnits: BigNumber,
  ): Promise<void> {
    if (!this.noLossCheckEnabled) return;
    const ceilingNative = simulatedNativeBaseUnits
      .multipliedBy(10000 + this.priorityHeadroomBps)
      .dividedBy(10000)
      .integerValue(BigNumber.ROUND_CEIL);
    const ceilingInSettlement = await this.pricing.nativeToFeeToken(chainId, settlementTokenAddressOrNative, ceilingNative);
    if (settlementAmountBaseUnits.isLessThan(ceilingInSettlement)) {
      throw PlutonException(GaslessErrors.FeeBelowMaxNetworkCost, {
        settlementAmount: settlementAmountBaseUnits.toFixed(),
        ceiling: ceilingInSettlement.toFixed(),
        headroomBps: this.priorityHeadroomBps,
      });
    }
  }

  /** Best-effort USD fields for the estimate response. Never throws. */
  async fiat(
    chainId: number,
    feeTokenAddressOrNative: string,
    feeAmountBaseUnits: BigNumber,
    nativeSentinel: string,
    simulatedNativeBaseUnits: BigNumber,
  ): Promise<FiatFields> {
    const fields: FiatFields = {};
    try {
      fields.feeUsd = (await this.pricing.toUsd(chainId, feeTokenAddressOrNative, feeAmountBaseUnits)).toFixed();
    } catch (err) {
      // warn (not debug): a systematically dead feed drops USD fields from every
      // response, which should be observable rather than silent.
      this.logger.warn(`feeUsd unavailable: ${(err as Error)?.message ?? err}`);
    }
    try {
      fields.estimatedNativeCostUsd = (await this.pricing.toUsd(chainId, nativeSentinel, simulatedNativeBaseUnits)).toFixed();
    } catch (err) {
      this.logger.warn(`estimatedNativeCostUsd unavailable: ${(err as Error)?.message ?? err}`);
    }
    return fields;
  }

  private profitFor(chainId: number, tokenAddressOrNative: string, symbol: string): BigNumber {
    const byAddress = this.profit.get(`${chainId}:${tokenAddressOrNative.trim().toLowerCase()}`);
    if (byAddress) return byAddress;
    const bySymbol = this.profit.get(`${chainId}:${symbol.trim().toLowerCase()}`);
    return bySymbol ?? new BigNumber(0);
  }
}

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { RangoClient } from '../../modules/rango/rango.client';
import { BaseJob, SchedulerName, SchedulerService } from '../scheduler';
import { PricingService } from './pricing.service';
import { PriceBlob, priceKey, TokenPriceEntry } from './pricing.types';

const DEFAULT_CRON = '*/5 * * * *';

/**
 * Pulls the full Rango `/basic/meta` token list on an interval and publishes it
 * as a single price blob for `PricingService`. Stores everything Rango returns
 * (no filtering) so adding a new accepted fee token needs no plumbing change.
 * Runs once on bootstrap so a fresh process has prices before the first tick.
 */
@Injectable()
export class TokenPriceRefreshJob extends BaseJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(TokenPriceRefreshJob.name);
  private lastPricedCount = 0;

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly rango: RangoClient,
    private readonly pricing: PricingService,
  ) {
    super();
    const cron = process.env.GASLESS_PRICE_REFRESH_CRON ?? DEFAULT_CRON;
    this.scheduler.register(SchedulerName.TokenPriceRefresh, this, cron);
  }

  async onApplicationBootstrap(): Promise<void> {
    // Prime prices before the first cron tick; a failure here must not abort
    // boot — the estimator will report PriceUnavailable until the next tick.
    await this.execute().catch((err) => {
      this.logger.error(`initial price prime failed: ${(err as Error)?.message ?? err}`);
    });
  }

  async execute(): Promise<void> {
    const tokens = await this.rango.meta();
    const map: Record<string, TokenPriceEntry> = {};
    let priced = 0;
    for (const t of tokens) {
      if (t.usdPrice === null || !Number.isFinite(t.usdPrice) || t.usdPrice <= 0) continue;
      // decimals feeds `10 ** decimals` in the fee math — a NaN/negative here
      // (NaN passes `typeof === 'number'`) would silently produce a NaN fee, so
      // reject it as firmly as a bad price.
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue;
      map[priceKey(t.chainName, t.address)] = { usdPrice: t.usdPrice, decimals: t.decimals };
      priced++;
    }
    if (priced === 0) {
      // Never overwrite a good blob with an empty one — a bad /meta response
      // would otherwise wipe all prices and take the fee path down.
      this.logger.error(`Rango /meta returned ${tokens.length} tokens but 0 usable prices; keeping last blob`);
      return;
    }
    // Coverage collapse (most tokens lost their price but ≥1 remains) publishes
    // a shrunken blob — each dropped token fails closed, but flag the aggregate
    // so scattered PriceUnavailable 503s aren't the only signal.
    if (this.lastPricedCount > 0 && priced < this.lastPricedCount / 2) {
      this.logger.error(`token price coverage dropped sharply: ${priced} priced now vs ${this.lastPricedCount} previously`);
    }
    this.lastPricedCount = priced;
    const blob: PriceBlob = { updatedAt: Date.now(), tokens: map };
    await this.pricing.publish(blob);
    this.logger.log(`token prices refreshed: ${priced} priced of ${tokens.length} tokens`);
  }
}

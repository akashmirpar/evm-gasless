import { Module } from '@nestjs/common';

import { SchedulerModule } from '../scheduler';
import { FeePolicyService } from './fee_policy.service';
import { PricingService } from './pricing.service';
import { TokenPriceRefreshJob } from './token_price_refresh.job';

// ChainConfigModule and RangoModule are @Global — no need to import them here.
@Module({
  imports: [SchedulerModule],
  providers: [PricingService, FeePolicyService, TokenPriceRefreshJob],
  exports: [PricingService, FeePolicyService],
})
export class PricingModule {}

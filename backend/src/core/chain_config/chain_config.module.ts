import { Global, Module } from '@nestjs/common';

import { ChainConfigService } from './chain_config.service';

@Global()
@Module({
  providers: [ChainConfigService],
  exports: [ChainConfigService],
})
export class ChainConfigModule {}

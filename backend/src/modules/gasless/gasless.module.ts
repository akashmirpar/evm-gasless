import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransitionLogEntity } from '../../common/transition_log.entity';
import { TransactionRequestEntity } from '../relayer/domain/entity/transaction_request.entity';
import { RelayerService } from '../relayer/relayer.service';
import { GaslessController } from './gasless.controller';
import { BatchBuilderService } from './services/batch_builder.service';
import { BatchHashService } from './services/batch_hash.service';
import { DelegateStateService } from './services/delegate_state.service';
import { FeeEstimatorService } from './services/fee_estimator.service';
import { GaslessCacheService } from './services/gasless_cache.service';
import { GaslessService } from './services/gasless.service';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionRequestEntity, TransitionLogEntity])],
  controllers: [GaslessController],
  providers: [
    GaslessService,
    FeeEstimatorService,
    BatchBuilderService,
    BatchHashService,
    DelegateStateService,
    GaslessCacheService,
    RelayerService,
  ],
  exports: [GaslessService, RelayerService],
})
export class GaslessModule {}

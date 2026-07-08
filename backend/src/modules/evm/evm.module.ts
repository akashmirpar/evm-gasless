import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransitionLogEntity } from '../../common/transition_log.entity';
import { TransactionRequestEntity } from '../relayer/domain/entity/transaction_request.entity';
import { RelayerService } from '../relayer/relayer.service';
import { EvmController } from './evm.controller';
import { BatchBuilderService } from './services/batch_builder.service';
import { BatchHashService } from './services/batch_hash.service';
import { DelegateStateService } from './services/delegate_state.service';
import { FeeEstimatorService } from './services/fee_estimator.service';
import { EvmCacheService } from './services/evm_cache.service';
import { EvmService } from './services/evm.service';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionRequestEntity, TransitionLogEntity])],
  controllers: [EvmController],
  providers: [
    EvmService,
    FeeEstimatorService,
    BatchBuilderService,
    BatchHashService,
    DelegateStateService,
    EvmCacheService,
    RelayerService,
  ],
  exports: [EvmService, RelayerService],
})
export class EvmModule {}

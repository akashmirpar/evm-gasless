import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransitionLogEntity } from '../../common/transition_log.entity';
import { SchedulerModule } from '../../core/scheduler';
import { TransactionRequestEntity } from './domain/entity/transaction_request.entity';
import { RelayerJob } from './jobs/relayer.job';
import { RelayerService } from './relayer.service';
import { EvmExecutorService } from './services/evm_executor.service';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionRequestEntity, TransitionLogEntity]), SchedulerModule],
  providers: [RelayerService, EvmExecutorService, RelayerJob],
  exports: [RelayerService, EvmExecutorService],
})
export class RelayerModule {}

import { Column, Index } from 'typeorm';

import { BaseEntity } from './base.entity';

@Index(['status', 'nextRetryTime'])
export abstract class BaseStatefulEntity<S extends number> extends BaseEntity {
  @Column({ type: 'smallint' })
  status!: S;

  @Column({ name: 'retry_times', type: 'smallint', default: 0 })
  retryTimes!: number;

  @Column({ name: 'next_retry_time', type: 'timestamptz', nullable: true })
  nextRetryTime!: Date | null;
}

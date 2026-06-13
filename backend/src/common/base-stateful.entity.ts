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

  @Column({ name: 'max_retry_times', type: 'smallint', nullable: true })
  maxRetryTimes!: number | null;

  @Column({ name: 'base_delay_ms', type: 'integer', nullable: true })
  baseDelayMs!: number | null;

  @Column({ name: 'exponential_rate', type: 'real', nullable: true })
  exponentialRate!: number | null;
}

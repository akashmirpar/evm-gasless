import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'transition_log' })
@Index(['entity', 'entityId', 'createdAt'])
export class TransitionLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column()
  entity!: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  @Column({ name: 'from_status', type: 'smallint' })
  fromStatus!: number;

  @Column({ name: 'to_status', type: 'smallint' })
  toStatus!: number;

  @Column({ type: 'smallint' })
  action!: number;

  @Column({ name: 'transition_by', type: 'varchar', nullable: true })
  transitionBy!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;
}

import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { AdminEntity } from './admin.entity';

export enum ApiKeyAuditOutcome {
  Created = 'created',
  Updated = 'updated',
  Deactivated = 'deactivated',
  Reactivated = 'reactivated',
  Deleted = 'deleted',
}

/**
 * Immutable audit row written in the same DB transaction as every
 * mutation to an integrator API key. `actor_admin_id` records who did it;
 * `ip` / `user_agent` capture the request context; `reason` is free-form.
 */
@Entity({ name: 'api_key_audit' })
export class ApiKeyAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'api_key_id', type: 'uuid' })
  apiKeyId!: string;

  @Column({ name: 'actor_admin_id', type: 'uuid' })
  actorAdminId!: string;

  @ManyToOne(() => AdminEntity)
  @JoinColumn({ name: 'actor_admin_id' })
  actorAdmin?: AdminEntity;

  @Column({ type: 'varchar' })
  outcome!: ApiKeyAuditOutcome;

  @Column({ type: 'varchar', nullable: true })
  ip!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;
}

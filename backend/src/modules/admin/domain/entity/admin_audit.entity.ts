import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { AdminEntity } from './admin.entity';

export enum AdminAuditOutcome {
  Created = 'created',
  Updated = 'updated',
  Deactivated = 'deactivated',
  Reactivated = 'reactivated',
  KeyRotated = 'key_rotated',
  Deleted = 'deleted',
}

@Entity({ name: 'admin_audit' })
export class AdminAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'admin_id', type: 'uuid' })
  adminId!: string;

  @Column({ name: 'actor_admin_id', type: 'uuid' })
  actorAdminId!: string;

  @ManyToOne(() => AdminEntity)
  @JoinColumn({ name: 'actor_admin_id' })
  actorAdmin?: AdminEntity;

  @Column({ type: 'varchar' })
  outcome!: AdminAuditOutcome;

  @Column({ type: 'varchar', nullable: true })
  ip!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;
}

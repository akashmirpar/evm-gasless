import { Column, Entity } from 'typeorm';

import { BaseEntity } from '../../../../common/base.entity';

/**
 * Integrator API key. Plaintext `key` stored with a unique index; the same
 * plaintext value is what callers put on the `x-api-key` header. There is no
 * `type` column — this table holds integrators only. Admins live in the
 * `admin` table under `src/modules/admin/`.
 */
@Entity({ name: 'api_key' })
export class ApiKeyEntity extends BaseEntity {
  @Column({ name: 'client_name', type: 'varchar', nullable: true })
  clientName!: string | null;

  @Column({ type: 'varchar', unique: true })
  key!: string;

  @Column({ name: 'rate_limit_rps', type: 'int', default: 5 })
  rateLimitRps!: number;

  /** Comma-separated allow-list of source IPs. `null` = no restriction. */
  @Column({ name: 'white_list', type: 'varchar', nullable: true })
  whiteList!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}

import { Column, Entity } from 'typeorm';

import { BaseEntity } from '../../../../common/base.entity';

/**
 * Administrator identity. `key` holds the plaintext admin API key and is
 * nullable so a future SIWE-based admin (wallet-signature login, no key)
 * can be inserted without a placeholder. Uniqueness on `key` is enforced
 * with a partial unique index in the migration.
 */
@Entity({ name: 'admin' })
export class AdminEntity extends BaseEntity {
  @Column({ type: 'varchar', unique: true })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  key!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}

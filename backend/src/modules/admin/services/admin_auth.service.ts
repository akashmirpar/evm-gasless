import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { IsNull, Not, Repository } from 'typeorm';

import { AuthErrors, PlutonException } from '../../../common/errors';
import { AdminEntity } from '../domain/entity/admin.entity';

const ADMIN_KEY_CACHE_PREFIX = 'gasless:auth:adminkey:';
const ADMIN_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

const DATE_FIELDS: readonly (keyof AdminEntity)[] = ['createdAt', 'updatedAt', 'deletedAt'];

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    @InjectRepository(AdminEntity)
    private readonly repository: Repository<AdminEntity>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Resolve an admin by their plaintext API key.
   * Throws `AuthErrors.Unauthorized` on unknown / inactive / soft-deleted rows.
   * Successful lookups are cached in Redis; `invalidateAdminCache` must be
   * called whenever an admin's `key`, `isActive`, or `deletedAt` changes.
   */
  async validateAdminKey(key: string): Promise<AdminEntity> {
    const admin = await this.loadAdmin(key);
    if (!admin || !admin.isActive) {
      throw PlutonException(AuthErrors.Unauthorized);
    }
    return admin;
  }

  async invalidateAdminCache(key: string): Promise<void> {
    await this.cache.del(`${ADMIN_KEY_CACHE_PREFIX}${key}`);
  }

  private async loadAdmin(key: string): Promise<AdminEntity | null> {
    const cacheKey = `${ADMIN_KEY_CACHE_PREFIX}${key}`;

    try {
      const cached = await this.cache.get<string>(cacheKey);
      if (cached) return reviveAdmin(JSON.parse(cached));
    } catch (err) {
      this.logger.warn(`admin cache read failed; falling through to DB: ${(err as Error)?.message ?? err}`);
    }

    // key column is nullable + covered by a partial unique index; findOne on a
    // string value is safe.
    const admin = await this.repository.findOne({ where: { key } });
    if (admin) {
      try {
        await this.cache.set(cacheKey, JSON.stringify(admin), ADMIN_KEY_CACHE_TTL_MS);
      } catch (err) {
        this.logger.warn(`admin cache write failed; continuing: ${(err as Error)?.message ?? err}`);
      }
    }
    return admin;
  }

  /** Count of active, non-deleted admins with a key set. */
  async countActiveAdminsWithKey(): Promise<number> {
    return this.repository.count({
      where: { isActive: true, key: Not(IsNull()) as unknown as string },
    });
  }
}

function reviveAdmin(raw: Record<string, unknown>): AdminEntity {
  const revived = { ...raw } as unknown as AdminEntity;
  for (const field of DATE_FIELDS) {
    const value = raw[field as string];
    if (typeof value === 'string') {
      (revived as unknown as Record<string, unknown>)[field as string] = new Date(value);
    }
  }
  return revived;
}

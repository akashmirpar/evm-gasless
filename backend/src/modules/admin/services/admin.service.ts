import { randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, Not } from 'typeorm';

import { AdminErrors, PlutonException } from '../../../common/errors';
import { AdminEntity } from '../domain/entity/admin.entity';
import { AdminAuditEntity, AdminAuditOutcome } from '../domain/entity/admin_audit.entity';
import { AdminAuthService } from './admin_auth.service';
import type { AdminContext } from './admin_context';

const ADMIN_KEY_PREFIX = 'ga_live_';

/**
 * Admin CRUD. Deactivating or deleting the last active admin with a key
 * would lock the operator out of their own service, so it is refused
 * with `AdminErrors.CannotDeactivateLastAdmin`.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly adminAuth: AdminAuthService,
  ) {}

  async list(): Promise<AdminEntity[]> {
    return this.dataSource
      .getRepository(AdminEntity)
      .find({ order: { createdAt: 'DESC' } });
  }

  async create(input: { name: string }, actor: AdminContext): Promise<{ admin: AdminEntity; plaintextKey: string }> {
    const plaintextKey = generateAdminKey();

    const admin = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AdminEntity);
      const clashName = await repo.findOne({ where: { name: input.name } });
      if (clashName) throw PlutonException(AdminErrors.AdminNameTaken);

      const entity = repo.create({ name: input.name, key: plaintextKey, isActive: true });
      const saved = await repo.save(entity);

      await manager.getRepository(AdminAuditEntity).save({
        adminId: saved.id,
        actorAdminId: actor.adminId,
        outcome: AdminAuditOutcome.Created,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });
      return saved;
    });

    return { admin, plaintextKey };
  }

  async rotateKey(id: string, actor: AdminContext): Promise<{ admin: AdminEntity; plaintextKey: string }> {
    const plaintextKey = generateAdminKey();

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AdminEntity);
      const target = await repo.findOne({ where: { id } });
      if (!target) throw PlutonException(AdminErrors.AdminNotFound);

      const previousKey = target.key;
      target.key = plaintextKey;
      const saved = await repo.save(target);

      await manager.getRepository(AdminAuditEntity).save({
        adminId: saved.id,
        actorAdminId: actor.adminId,
        outcome: AdminAuditOutcome.KeyRotated,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      if (previousKey) await this.adminAuth.invalidateAdminCache(previousKey);
      return { admin: saved, plaintextKey };
    });
  }

  async setActive(id: string, isActive: boolean, actor: AdminContext): Promise<AdminEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AdminEntity);
      const target = await repo.findOne({ where: { id } });
      if (!target) throw PlutonException(AdminErrors.AdminNotFound);

      if (!isActive && target.isActive) {
        await this.assertNotLastActiveAdmin(repo, target.id);
      }

      target.isActive = isActive;
      const saved = await repo.save(target);

      await manager.getRepository(AdminAuditEntity).save({
        adminId: saved.id,
        actorAdminId: actor.adminId,
        outcome: isActive ? AdminAuditOutcome.Reactivated : AdminAuditOutcome.Deactivated,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      if (target.key) await this.adminAuth.invalidateAdminCache(target.key);
      return saved;
    });
  }

  async delete(id: string, actor: AdminContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AdminEntity);
      const target = await repo.findOne({ where: { id } });
      if (!target) throw PlutonException(AdminErrors.AdminNotFound);

      if (target.isActive) {
        await this.assertNotLastActiveAdmin(repo, target.id);
      }

      await repo.softRemove(target);

      await manager.getRepository(AdminAuditEntity).save({
        adminId: target.id,
        actorAdminId: actor.adminId,
        outcome: AdminAuditOutcome.Deleted,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      if (target.key) await this.adminAuth.invalidateAdminCache(target.key);
    });
  }

  private async assertNotLastActiveAdmin(
    repo: import('typeorm').Repository<AdminEntity>,
    excludeId: string,
  ): Promise<void> {
    const remaining = await repo.count({
      where: {
        id: Not(excludeId),
        isActive: true,
        key: Not(IsNull()) as unknown as string,
      },
    });
    if (remaining === 0) throw PlutonException(AdminErrors.CannotDeactivateLastAdmin);
  }
}

function generateAdminKey(): string {
  return `${ADMIN_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

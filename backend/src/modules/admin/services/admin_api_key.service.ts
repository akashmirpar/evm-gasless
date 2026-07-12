import { randomBytes } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AdminErrors, PlutonException } from '../../../common/errors';
import { ApiKeyEntity } from '../../auth/domain/entity/api_key.entity';
import { AuthService } from '../../auth/services/auth.service';
import { ApiKeyAuditEntity, ApiKeyAuditOutcome } from '../domain/entity/api_key_audit.entity';
import type { AdminContext } from './admin_context';

const KEY_PREFIX = 'gk_live_';

/**
 * Manages integrator API keys. All mutations run inside a single DB
 * transaction with an `api_key_audit` insert, so the audit trail can never
 * diverge from the state it describes.
 */
@Injectable()
export class AdminApiKeyService {
  private readonly logger = new Logger(AdminApiKeyService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
  ) {}

  async list(): Promise<ApiKeyEntity[]> {
    return this.dataSource
      .getRepository(ApiKeyEntity)
      .find({ order: { createdAt: 'DESC' } });
  }

  async create(
    input: {
      clientName?: string | null;
      rateLimitRps?: number;
      whiteList?: string | null;
      expiresAt?: Date | null;
    },
    actor: AdminContext,
  ): Promise<ApiKeyEntity> {
    const key = generatePlaintextKey();

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ApiKeyEntity);

      // Extremely unlikely with 32 bytes of entropy, but a collision would
      // silently break the caller's lookup, so we surface it as a distinct
      // 409 the client can retry.
      const clash = await repo.findOne({ where: { key } });
      if (clash) throw PlutonException(AdminErrors.KeyAlreadyExists);

      const entity = repo.create({
        clientName: input.clientName ?? null,
        key,
        rateLimitRps: input.rateLimitRps ?? 5,
        whiteList: input.whiteList ?? null,
        expiresAt: input.expiresAt ?? null,
        isActive: true,
      });
      const saved = await repo.save(entity);

      await manager.getRepository(ApiKeyAuditEntity).save({
        apiKeyId: saved.id,
        actorAdminId: actor.adminId,
        outcome: ApiKeyAuditOutcome.Created,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      return saved;
    });
  }

  async update(
    id: string,
    patch: {
      clientName?: string | null;
      rateLimitRps?: number;
      whiteList?: string | null;
      expiresAt?: Date | null;
    },
    actor: AdminContext,
  ): Promise<ApiKeyEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ApiKeyEntity);
      const target = await repo.findOne({ where: { id } });
      if (!target) throw PlutonException(AdminErrors.ApiKeyNotFound);

      if (patch.clientName !== undefined) target.clientName = patch.clientName;
      if (patch.rateLimitRps !== undefined) target.rateLimitRps = patch.rateLimitRps;
      if (patch.whiteList !== undefined) target.whiteList = patch.whiteList;
      if (patch.expiresAt !== undefined) target.expiresAt = patch.expiresAt;

      const saved = await repo.save(target);

      await manager.getRepository(ApiKeyAuditEntity).save({
        apiKeyId: saved.id,
        actorAdminId: actor.adminId,
        outcome: ApiKeyAuditOutcome.Updated,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      await this.authService.invalidateApiKeyCache(saved.key);
      return saved;
    });
  }

  async setActive(id: string, isActive: boolean, actor: AdminContext): Promise<ApiKeyEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ApiKeyEntity);
      const target = await repo.findOne({ where: { id } });
      if (!target) throw PlutonException(AdminErrors.ApiKeyNotFound);

      target.isActive = isActive;
      const saved = await repo.save(target);

      await manager.getRepository(ApiKeyAuditEntity).save({
        apiKeyId: saved.id,
        actorAdminId: actor.adminId,
        outcome: isActive ? ApiKeyAuditOutcome.Reactivated : ApiKeyAuditOutcome.Deactivated,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      await this.authService.invalidateApiKeyCache(saved.key);
      return saved;
    });
  }

  async delete(id: string, actor: AdminContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ApiKeyEntity);
      const target = await repo.findOne({ where: { id } });
      if (!target) throw PlutonException(AdminErrors.ApiKeyNotFound);

      await repo.softRemove(target);

      await manager.getRepository(ApiKeyAuditEntity).save({
        apiKeyId: target.id,
        actorAdminId: actor.adminId,
        outcome: ApiKeyAuditOutcome.Deleted,
        ip: actor.ip,
        userAgent: actor.userAgent,
        reason: actor.reason,
      });

      await this.authService.invalidateApiKeyCache(target.key);
    });
  }
}

/** 32-byte URL-safe token → 43-char base64url + human-readable prefix. */
function generatePlaintextKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

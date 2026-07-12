import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { Repository } from 'typeorm';

import { AuthErrors, PlutonException } from '../../../common/errors';
import { ApiKeyEntity } from '../domain/entity/api_key.entity';

const API_KEY_CACHE_PREFIX = 'gasless:auth:apikey:';
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Date-typed columns that must be revived after a JSON round-trip. */
const DATE_FIELDS: readonly (keyof ApiKeyEntity)[] = ['expiresAt', 'createdAt', 'updatedAt', 'deletedAt'];

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly repository: Repository<ApiKeyEntity>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Resolve and authorize an integrator API key for an inbound request.
   * Throws `AuthErrors.Unauthorized` when the key is unknown, inactive, or
   * expired; `AuthErrors.Forbidden` when the caller's IP is not whitelisted.
   * Successful lookups are cached in Redis to keep the guard off the DB.
   */
  async validateApiKey(apiKey: string, ip?: string): Promise<ApiKeyEntity> {
    const details = await this.loadApiKey(apiKey);

    if (!details || !details.isActive) {
      throw PlutonException(AuthErrors.Unauthorized);
    }

    if (details.expiresAt && details.expiresAt.getTime() < Date.now()) {
      throw PlutonException(AuthErrors.Unauthorized);
    }

    if (details.whiteList) {
      const allowed = details.whiteList.split(',').map((entry) => entry.trim()).filter(Boolean);
      // Malformed whitelist entries fail closed — an admin typing "1.2.3." almost
      // certainly meant to lock the key, not open it.
      if (allowed.length === 0 || !ip || !allowed.includes(ip)) {
        throw PlutonException(AuthErrors.Forbidden);
      }
    }

    return details;
  }

  /** Drop a cached key so a permission/activation change takes effect at once. */
  async invalidateApiKeyCache(apiKey: string): Promise<void> {
    await this.cache.del(`${API_KEY_CACHE_PREFIX}${apiKey}`);
  }

  private async loadApiKey(apiKey: string): Promise<ApiKeyEntity | null> {
    const cacheKey = `${API_KEY_CACHE_PREFIX}${apiKey}`;

    try {
      const cached = await this.cache.get<string>(cacheKey);
      if (cached) {
        return reviveApiKey(JSON.parse(cached));
      }
    } catch (err) {
      // Fail open on cache read errors — fall through to the DB.
      this.logger.warn(`api-key cache read failed; falling through to DB: ${(err as Error)?.message ?? err}`);
    }

    const details = await this.repository.findOne({ where: { key: apiKey } });
    if (details) {
      try {
        await this.cache.set(cacheKey, JSON.stringify(details), API_KEY_CACHE_TTL_MS);
      } catch (err) {
        this.logger.warn(`api-key cache write failed; continuing: ${(err as Error)?.message ?? err}`);
      }
    }
    return details;
  }
}

function reviveApiKey(raw: Record<string, unknown>): ApiKeyEntity {
  const revived = { ...raw } as unknown as ApiKeyEntity;
  for (const field of DATE_FIELDS) {
    const value = raw[field as string];
    if (typeof value === 'string') {
      (revived as unknown as Record<string, unknown>)[field as string] = new Date(value);
    }
  }
  return revived;
}

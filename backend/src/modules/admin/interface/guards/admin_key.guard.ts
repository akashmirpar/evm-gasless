import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { AuthErrors, PlutonException } from '../../../../common/errors';
import { REDIS_KEY_PREFIX } from '../../../../common/redis';
import { RateLimiterService } from '../../../auth/services/rate_limiter.service';
import { AdminAuthService } from '../../services/admin_auth.service';
import type { AdminEntity } from '../../domain/entity/admin.entity';

const FAILED_AUTH_IP_LIMIT = 5;
const RATE_WINDOW_SECONDS = 1;

/**
 * Guards admin-only routes. Reads `x-admin-key` (falls back to `admin-key`),
 * shares the same per-IP failed-auth budget key-space as `ApiKeyGuard` so a
 * bad actor hammering either header burns a single budget.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = extractAdminKey(request);
    const ip = extractIp(request);
    const failureKey = `${REDIS_KEY_PREFIX}authfail:ip:${ip ?? 'unknown'}`;

    if ((await this.rateLimiter.peek(failureKey)) >= FAILED_AUTH_IP_LIMIT) {
      throw PlutonException(AuthErrors.Forbidden);
    }

    if (!key) {
      await this.countFailure(failureKey);
      throw PlutonException(AuthErrors.Unauthorized);
    }

    let admin: AdminEntity;
    try {
      admin = await this.adminAuth.validateAdminKey(key);
    } catch (err) {
      await this.countFailure(failureKey);
      throw err;
    }

    attachAdmin(request, admin);
    return true;
  }

  private async countFailure(failureKey: string): Promise<void> {
    await this.rateLimiter.hit(failureKey, FAILED_AUTH_IP_LIMIT, RATE_WINDOW_SECONDS);
  }
}

function extractAdminKey(request: Request): string | undefined {
  const raw = request.headers['x-admin-key'] ?? request.headers['admin-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.ip ?? forwardedIp ?? request.socket?.remoteAddress ?? undefined;
}

function attachAdmin(request: Request, admin: AdminEntity): void {
  const carrier = request as unknown as { admin?: AdminEntity; adminId?: string };
  carrier.admin = admin;
  carrier.adminId = admin.id;
}

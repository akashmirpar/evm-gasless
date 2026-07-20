import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { AuthErrors, PlutonException } from '../../../../common/errors';
import { REDIS_KEY_PREFIX } from '../../../../common/redis';
import { AuthService } from '../../services/auth.service';
import { RateLimiterService } from '../../services/rate_limiter.service';
import type { ApiKeyEntity } from '../../domain/entity/api_key.entity';

/**
 * Per-IP budget of *failed* authentications (missing / unknown / inactive /
 * expired key, or IP not whitelisted) per window. Once an IP burns this budget
 * it is rejected before the key lookup, so an invalid-key flood cannot amplify
 * into one DB query per request. Volumetric flood protection proper belongs at
 * the edge (Caddy / LB); this only bounds DB amplification.
 */
const FAILED_AUTH_IP_LIMIT = 5;

/** All rate-limit windows are one second wide. */
const RATE_WINDOW_SECONDS = 1;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = extractApiKey(request);
    const ip = extractIp(request);
    const failureKey = `${REDIS_KEY_PREFIX}authfail:ip:${ip ?? 'unknown'}`;

    if ((await this.rateLimiter.peek(failureKey)) >= FAILED_AUTH_IP_LIMIT) {
      throw PlutonException(AuthErrors.Forbidden);
    }

    if (!apiKey) {
      await this.countFailure(failureKey);
      throw PlutonException(AuthErrors.Unauthorized);
    }

    let apiKeyDetails: ApiKeyEntity;
    try {
      apiKeyDetails = await this.authService.validateApiKey(apiKey, ip);
    } catch (err) {
      await this.countFailure(failureKey);
      throw err;
    }

    if (apiKeyDetails.rateLimitRps > 0) {
      const within = await this.rateLimiter.hit(
        `${REDIS_KEY_PREFIX}rps:apikey:${apiKey}`,
        apiKeyDetails.rateLimitRps,
        RATE_WINDOW_SECONDS,
      );
      if (!within) throw PlutonException(AuthErrors.RateLimited);
    }

    attachIntegrator(request, apiKey, apiKeyDetails);
    return true;
  }

  private async countFailure(failureKey: string): Promise<void> {
    await this.rateLimiter.hit(failureKey, FAILED_AUTH_IP_LIMIT, RATE_WINDOW_SECONDS);
  }
}

function extractApiKey(request: Request): string | undefined {
  const raw = request.headers['x-api-key'] ?? request.headers['apikey'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.ip ?? forwardedIp ?? request.socket?.remoteAddress ?? undefined;
}

function attachIntegrator(request: Request, apiKey: string, details: ApiKeyEntity): void {
  const carrier = request as unknown as {
    integrator?: ApiKeyEntity;
    integratorId?: string;
    apiKey?: string;
  };
  carrier.integrator = details;
  carrier.integratorId = details.id;
  carrier.apiKey = apiKey;
}

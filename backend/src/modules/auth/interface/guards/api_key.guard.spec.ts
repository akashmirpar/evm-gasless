import { ExecutionContext } from '@nestjs/common';

import { PlutonHttpException } from '../../../../common/errors';
import { ErrorCodes } from '../../../../common/errors/codes';
import { REDIS_KEY_PREFIX } from '../../../../common/redis';
import { ApiKeyGuard } from './api_key.guard';

function makeCtx(headers: Record<string, string> = {}, ip = '1.2.3.4'): ExecutionContext {
  const request = { headers, ip, socket: { remoteAddress: ip } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeGuard(overrides: {
  validate?: jest.Mock;
  hit?: jest.Mock;
  peek?: jest.Mock;
} = {}): { guard: ApiKeyGuard; authService: { validateApiKey: jest.Mock }; rateLimiter: { hit: jest.Mock; peek: jest.Mock } } {
  const authService = { validateApiKey: overrides.validate ?? jest.fn().mockResolvedValue({ id: 'id-1', key: 'k', rateLimitRps: 5 }) };
  const rateLimiter = {
    hit: overrides.hit ?? jest.fn().mockResolvedValue(true),
    peek: overrides.peek ?? jest.fn().mockResolvedValue(0),
  };
  const guard = new ApiKeyGuard(authService as never, rateLimiter as never);
  return { guard, authService, rateLimiter };
}

describe('ApiKeyGuard', () => {
  it('rejects when the header is missing and counts the failure against the IP', async () => {
    const { guard, rateLimiter } = makeGuard();
    await expect(guard.canActivate(makeCtx({}))).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_UNAUTHORIZED },
    });
    expect(rateLimiter.hit).toHaveBeenCalledWith(expect.stringContaining(`${REDIS_KEY_PREFIX}authfail:ip:`), 5, 1);
  });

  it('rejects an IP that has already burned its failed-auth budget without touching authService', async () => {
    const { guard, authService, rateLimiter } = makeGuard({ peek: jest.fn().mockResolvedValue(5) });
    await expect(guard.canActivate(makeCtx({ 'x-api-key': 'anything' }))).rejects.toBeInstanceOf(PlutonHttpException);
    expect(authService.validateApiKey).not.toHaveBeenCalled();
    expect(rateLimiter.hit).not.toHaveBeenCalled();
  });

  it('surfaces the auth error AND increments the IP failure counter on a bad key', async () => {
    const validate = jest.fn().mockRejectedValue(
      new PlutonHttpException({
        code: ErrorCodes.AUTH_UNAUTHORIZED,
        httpCode: 401,
        message: 'invalid api key',
        service: 'Auth',
      }),
    );
    const { guard, rateLimiter } = makeGuard({ validate });
    await expect(guard.canActivate(makeCtx({ 'x-api-key': 'bad' }))).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_UNAUTHORIZED },
    });
    expect(rateLimiter.hit).toHaveBeenCalledWith(expect.stringContaining(`${REDIS_KEY_PREFIX}authfail:ip:`), 5, 1);
  });

  it('enforces the per-key RPS budget with a 429/RATE_LIMITED error', async () => {
    const { guard } = makeGuard({ hit: jest.fn().mockResolvedValue(false) });
    await expect(guard.canActivate(makeCtx({ 'x-api-key': 'ok' }))).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_RATE_LIMITED, httpCode: 429 },
    });
  });

  it('attaches integrator + integratorId + apiKey on a valid call', async () => {
    const validate = jest.fn().mockResolvedValue({ id: 'id-1', key: 'ok', rateLimitRps: 0 });
    const { guard } = makeGuard({ validate });
    const ctx = makeCtx({ 'x-api-key': 'ok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ integrator?: { id: string }; integratorId?: string; apiKey?: string }>();
    expect(req.integrator?.id).toBe('id-1');
    expect(req.integratorId).toBe('id-1');
    expect(req.apiKey).toBe('ok');
  });

  it('accepts the legacy "apikey" header as a fallback', async () => {
    const { guard, authService } = makeGuard();
    await guard.canActivate(makeCtx({ apikey: 'legacy' }));
    expect(authService.validateApiKey).toHaveBeenCalledWith('legacy', expect.any(String));
  });
});

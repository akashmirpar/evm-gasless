import { PlutonHttpException } from '../../../common/errors';
import { ErrorCodes } from '../../../common/errors/codes';
import { AuthService } from './auth.service';
import { ApiKeyEntity } from '../domain/entity/api_key.entity';

interface FakeRepo {
  findOne: jest.Mock;
}
interface FakeCache {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
}

function buildRow(overrides: Partial<ApiKeyEntity> = {}): ApiKeyEntity {
  return {
    id: 'id-1',
    clientName: 'acme',
    key: 'plaintext',
    rateLimitRps: 5,
    whiteList: null,
    expiresAt: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: null,
    deletedAt: null,
    ...overrides,
  } as ApiKeyEntity;
}

function makeService(row: ApiKeyEntity | null, cachedRaw?: string | null): { svc: AuthService; repo: FakeRepo; cache: FakeCache } {
  const repo: FakeRepo = { findOne: jest.fn().mockResolvedValue(row) };
  const cache: FakeCache = {
    get: jest.fn().mockResolvedValue(cachedRaw ?? null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new AuthService(
    repo as unknown as import('typeorm').Repository<ApiKeyEntity>,
    cache as unknown as import('cache-manager').Cache,
  );
  return { svc, repo, cache };
}

describe('AuthService.validateApiKey', () => {
  it('rejects an unknown key with 401/UNAUTHORIZED', async () => {
    const { svc } = makeService(null);
    await expect(svc.validateApiKey('missing')).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_UNAUTHORIZED, httpCode: 401 },
    });
  });

  it('rejects an inactive key', async () => {
    const { svc } = makeService(buildRow({ isActive: false }));
    await expect(svc.validateApiKey('plaintext')).rejects.toBeInstanceOf(PlutonHttpException);
  });

  it('rejects an expired key', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const { svc } = makeService(buildRow({ expiresAt: yesterday }));
    await expect(svc.validateApiKey('plaintext')).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_UNAUTHORIZED },
    });
  });

  it('accepts an unexpired active key', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const { svc } = makeService(buildRow({ expiresAt: tomorrow }));
    await expect(svc.validateApiKey('plaintext')).resolves.toMatchObject({ id: 'id-1' });
  });

  it('rejects with 403 when IP is not in the whitelist', async () => {
    const { svc } = makeService(buildRow({ whiteList: '1.1.1.1, 2.2.2.2' }));
    await expect(svc.validateApiKey('plaintext', '9.9.9.9')).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_FORBIDDEN, httpCode: 403 },
    });
  });

  it('accepts when the caller IP matches the whitelist', async () => {
    const { svc } = makeService(buildRow({ whiteList: '1.1.1.1, 2.2.2.2' }));
    await expect(svc.validateApiKey('plaintext', '2.2.2.2')).resolves.toMatchObject({ id: 'id-1' });
  });

  it('rejects when whitelist is set but IP is missing (fails closed)', async () => {
    const { svc } = makeService(buildRow({ whiteList: '1.1.1.1' }));
    await expect(svc.validateApiKey('plaintext', undefined)).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.AUTH_FORBIDDEN },
    });
  });

  it('revives cached Date fields after a JSON round-trip', async () => {
    const rowAsJson = JSON.stringify(buildRow({ expiresAt: new Date(Date.now() + 60_000) }));
    const { svc, repo } = makeService(null, rowAsJson);
    await expect(svc.validateApiKey('plaintext')).resolves.toMatchObject({ id: 'id-1' });
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

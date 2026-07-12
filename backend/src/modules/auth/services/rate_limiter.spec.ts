import { RateLimiterService } from './rate_limiter.service';

interface FakeRedis {
  eval: jest.Mock;
  get: jest.Mock;
  quit: jest.Mock;
}

function makeService(redis: FakeRedis): RateLimiterService {
  return new RateLimiterService(redis as unknown as import('ioredis').Redis);
}

describe('RateLimiterService', () => {
  describe('hit', () => {
    it('returns true while the count is <= limit', async () => {
      const redis: FakeRedis = { eval: jest.fn().mockResolvedValue(3), get: jest.fn(), quit: jest.fn() };
      const svc = makeService(redis);
      expect(await svc.hit('k', 5, 1)).toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'k', '1');
    });

    it('returns false once the count exceeds limit', async () => {
      const redis: FakeRedis = { eval: jest.fn().mockResolvedValue(6), get: jest.fn(), quit: jest.fn() };
      const svc = makeService(redis);
      expect(await svc.hit('k', 5, 1)).toBe(false);
    });

    it('fails open when redis throws — a limiter outage must not down the API', async () => {
      const redis: FakeRedis = {
        eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        get: jest.fn(),
        quit: jest.fn(),
      };
      const svc = makeService(redis);
      expect(await svc.hit('k', 5, 1)).toBe(true);
    });
  });

  describe('peek', () => {
    it('returns 0 when the key is absent', async () => {
      const redis: FakeRedis = { eval: jest.fn(), get: jest.fn().mockResolvedValue(null), quit: jest.fn() };
      expect(await makeService(redis).peek('k')).toBe(0);
    });

    it('coerces the stored string to a number', async () => {
      const redis: FakeRedis = { eval: jest.fn(), get: jest.fn().mockResolvedValue('4'), quit: jest.fn() };
      expect(await makeService(redis).peek('k')).toBe(4);
    });

    it('fails open with 0 when redis throws', async () => {
      const redis: FakeRedis = { eval: jest.fn(), get: jest.fn().mockRejectedValue(new Error('boom')), quit: jest.fn() };
      expect(await makeService(redis).peek('k')).toBe(0);
    });
  });
});

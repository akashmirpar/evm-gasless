import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** DI token for the dedicated ioredis client used by the rate limiter. */
export const RATE_LIMIT_REDIS = 'RATE_LIMIT_REDIS';

/**
 * Atomic fixed-window counter. INCR the key and, only on the first hit of a
 * window, set its TTL — both in a single server-side script so concurrent
 * callers cannot bypass the cap through a read-modify-write race.
 * Returns the post-increment count.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(@Inject(RATE_LIMIT_REDIS) private readonly client: Redis) {}

  /**
   * Count one hit against `key` within a fixed `windowSeconds` window and
   * report whether the caller is still within `limit` (inclusive). Fails
   * open (returns `true`) when Redis is unreachable — a limiter-backend
   * outage must not take the whole API down.
   */
  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      const count = (await this.client.eval(FIXED_WINDOW_SCRIPT, 1, key, String(windowSeconds))) as number;
      return count <= limit;
    } catch (err) {
      this.logger.warn(`rate limiter unavailable; allowing request (fail-open) key=${key} err=${(err as Error)?.message ?? err}`);
      return true;
    }
  }

  /**
   * Read the current count for `key` without incrementing it (`0` if absent).
   * Used to reject an already-over-budget caller before doing expensive work.
   */
  async peek(key: string): Promise<number> {
    try {
      const raw = await this.client.get(key);
      return raw ? Number(raw) : 0;
    } catch (err) {
      this.logger.warn(`rate limiter peek unavailable; treating as 0 (fail-open) key=${key} err=${(err as Error)?.message ?? err}`);
      return 0;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

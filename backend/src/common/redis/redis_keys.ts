/**
 * Namespace shared by every Redis key this service owns.
 *
 * The relayer shares its Redis instance with other Pluton services, so all
 * gasless keys live under a single prefix: keyspaces cannot collide, an ACL can
 * grant this service `gasless:*` and nothing else, and the whole namespace stays
 * scannable (and flushable) as one unit.
 *
 * The trailing colon is part of the prefix, so compose keys as
 * `${REDIS_KEY_PREFIX}<domain>:<identifier>` — e.g. `gasless:auth:apikey:<uuid>`.
 * This applies to both cache-manager/Keyv entries and the keys the rate limiter
 * passes straight to ioredis.
 */
export const REDIS_KEY_PREFIX = 'gasless:';

import type { Redis } from 'ioredis';

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * A fixed window per API key, counted in Redis so it holds across replicas.
 *
 * Fixed rather than sliding: a sliding window needs a sorted set and a
 * trim on every request, and the failure mode of a fixed window — up to twice
 * the limit across a window boundary — is one this service can absorb, because
 * the thing that actually protects the bill is the budget breaker. Rate
 * limiting here is about protecting the upstream from one noisy key.
 */
export function createRateLimiter(redis: Redis, perMinute: number) {
  return {
    async check(apiKey: string, now = new Date()): Promise<RateDecision> {
      const window = Math.floor(now.getTime() / 60_000);
      const key = `ratelimit:${apiKey}:${String(window)}`;
      const retryAfterSeconds = Math.max(1, 60 - now.getUTCSeconds());

      // INCR then EXPIRE, with the expiry set only on the first hit of the
      // window. Two commands, one round trip.
      const [count] = (await redis.multi().incr(key).expire(key, 120).exec()) ?? [];
      const used = typeof count?.[1] === 'number' ? count[1] : Number(count?.[1] ?? 0);

      return {
        allowed: used <= perMinute,
        remaining: Math.max(0, perMinute - used),
        retryAfterSeconds,
      };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

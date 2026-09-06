import { Redis } from 'ioredis';
import type { AppDependencies } from './app.ts';
import type { Config } from './config.ts';
import { createBudgetBreaker } from './accounting/budget.ts';
import { createRedisLedger } from './accounting/ledger.ts';
import {
  createDeterministicEmbedder,
  createExactCache,
  createNullCache,
  createSemanticCache,
} from './cache/index.ts';
import { createBasicModerator } from './middleware/moderation.ts';
import { createRateLimiter } from './middleware/rate-limit.ts';
import { createPromptRegistry } from './prompts/registry.ts';
import { createProvider } from './providers/index.ts';
import { createLogger } from './telemetry/logger.ts';

export interface Runtime {
  deps: AppDependencies;
  redis: Redis;
  close(): Promise<void>;
}

export function createRuntime(config: Config): Runtime {
  const redis = new Redis(config.REDIS_URL, {
    // The budget breaker has to be able to fail fast to fail closed. Left to
    // the default the client queues commands forever and a request hangs
    // instead of being refused.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  // Without a listener a connection error is an unhandled 'error' event and
  // takes the process down — the opposite of degrading gracefully.
  redis.on('error', () => undefined);

  const logger = createLogger(config);

  const cache =
    config.CACHE_MODE === 'off'
      ? createNullCache()
      : config.CACHE_MODE === 'semantic'
        ? createSemanticCache(redis, {
            ttlSeconds: config.CACHE_TTL_SECONDS,
            threshold: config.SEMANTIC_THRESHOLD,
            embed: createDeterministicEmbedder(),
          })
        : createExactCache(redis, config.CACHE_TTL_SECONDS);

  const deps: AppDependencies = {
    config,
    provider: createProvider(config),
    cache,
    ledger: createRedisLedger(redis),
    budget: createBudgetBreaker(redis, {
      monthlyBudgetUsd: config.MONTHLY_BUDGET_USD,
      failMode: config.BUDGET_FAIL_MODE,
    }),
    rateLimiter: createRateLimiter(redis, config.RATE_LIMIT_PER_MINUTE),
    moderator: createBasicModerator(),
    prompts: createPromptRegistry(),
    logger,
  };

  return {
    deps,
    redis,
    async close() {
      await redis.quit().catch(() => undefined);
    },
  };
}

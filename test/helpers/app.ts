import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe } from 'vitest';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createApp, type AppDependencies } from '../../src/app.ts';
import { parseConfig, type Config } from '../../src/config.ts';
import { createMemoryLedger } from '../../src/accounting/ledger.ts';
import { createNullCache } from '../../src/cache/index.ts';
import { createAllowAllModerator } from '../../src/middleware/moderation.ts';
import { createPromptRegistry } from '../../src/prompts/registry.ts';
import { createMockProvider, withRetry, type Provider } from '../../src/providers/index.ts';

export const redisUrl = process.env.REDIS_URL;

/**
 * Suites that need Redis skip visibly without it rather than passing against a
 * fake. The budget breaker's whole point is an atomic counter shared between
 * replicas, which an in-process stand-in cannot demonstrate.
 */
export const describeWithRedis = redisUrl ? describe : describe.skip;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    NODE_ENV: 'test',
    PROVIDER: 'mock',
    MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'silent',
    ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
    ...overrides,
  });
}

export interface Harness {
  deps: AppDependencies;
  app: ReturnType<typeof createApp>;
  ledger: ReturnType<typeof createMemoryLedger>;
}

export function buildApp(
  options: {
    provider?: Provider;
    config?: Config;
    redis?: Redis;
    overrides?: Partial<AppDependencies>;
  } = {},
): Harness {
  const config = options.config ?? testConfig();
  const ledger = createMemoryLedger();

  // A breaker that never refuses, for suites not testing the budget. The ones
  // that are testing it pass a real Redis-backed breaker instead.
  const budget: AppDependencies['budget'] = {
    check: () => Promise.resolve({ allowed: true, spentUsd: 0, remainingUsd: 1000 }),
    add: () => Promise.resolve(),
    spent: () => Promise.resolve(0),
  };

  const rateLimiter: AppDependencies['rateLimiter'] = {
    check: () => Promise.resolve({ allowed: true, remaining: 100, retryAfterSeconds: 60 }),
  };

  const deps: AppDependencies = {
    config,
    provider:
      options.provider ?? withRetry(createMockProvider(), { maxRetries: 0, timeoutMs: 5000 }),
    cache: createNullCache(),
    ledger,
    budget,
    rateLimiter,
    moderator: createAllowAllModerator(),
    prompts: createPromptRegistry(),
    logger: pino({ level: 'silent' }),
    ...options.overrides,
  };

  return { deps, app: createApp(deps), ledger };
}

export interface Listening {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/**
 * A real listening server, needed wherever the test has to behave like a client
 * that goes away — supertest cannot abort a response mid-stream.
 */
export async function listen(app: ReturnType<typeof createApp>): Promise<Listening> {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * A client for the suites that need one.
 *
 * This runs at collection time, inside a `describe` that may be skipped —
 * vitest still executes the callback to register the skipped tests. Throwing
 * here would fail the file instead of skipping it, which is the opposite of
 * what the guard is for. Without REDIS_URL it returns a lazy client that never
 * connects, and the tests that would use it do not run.
 */
export function connectRedis(db = 6): Redis {
  const url = new URL(redisUrl ?? 'redis://127.0.0.1:6379');
  url.pathname = `/${String(db)}`;
  // Offline queue left on so the first command waits for the connection
  // rather than being rejected before it is established.
  return new Redis(url.toString(), { maxRetriesPerRequest: 2, lazyConnect: !redisUrl });
}

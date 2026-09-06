import { afterAll, beforeEach, expect, it } from 'vitest';
import { createRedisLedger, LEDGER_KEY, type LedgerEntry } from '../../src/accounting/ledger.ts';
import { createRateLimiter } from '../../src/middleware/rate-limit.ts';
import {
  createDeterministicEmbedder,
  createExactCache,
  createSemanticCache,
} from '../../src/cache/index.ts';
import { connectRedis, describeWithRedis } from '../helpers/app.ts';

const redis = connectRedis(6);

// One client for the whole file, closed once at the end. Closing it inside the
// first describe would leave the later ones talking to a dead connection.
afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: new Date().toISOString(),
    requestId: 'req-1',
    apiKey: '…abcd',
    provider: 'mock',
    model: 'gpt-4o-mini',
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.0001,
    estimated: false,
    cached: false,
    streamed: false,
    outcome: 'ok',
    ...overrides,
  };
}

describeWithRedis('redis ledger', () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  it('round-trips an entry through the stream', async () => {
    const ledger = createRedisLedger(redis);
    await ledger.record(entry({ requestId: 'abc' }));

    const [recorded] = await ledger.recent(10);
    expect(recorded).toMatchObject({
      requestId: 'abc',
      model: 'gpt-4o-mini',
      promptTokens: 10,
      completionTokens: 20,
      costUsd: 0.0001,
      outcome: 'ok',
    });
  });

  it('keeps a null cost distinguishable from a zero cost', async () => {
    const ledger = createRedisLedger(redis);
    await ledger.record(entry({ requestId: 'unknown-model', costUsd: null }));
    await ledger.record(entry({ requestId: 'free', costUsd: 0 }));

    const recent = await ledger.recent(10);
    // Redis stores strings, so this is exactly where "we could not price it"
    // would silently become "it was free".
    expect(recent.find((row) => row.requestId === 'unknown-model')?.costUsd).toBeNull();
    expect(recent.find((row) => row.requestId === 'free')?.costUsd).toBe(0);
  });

  it('preserves booleans across the string round trip', async () => {
    const ledger = createRedisLedger(redis);
    await ledger.record(entry({ cached: true, streamed: false, estimated: true }));

    const [recorded] = await ledger.recent(1);
    expect(recorded).toMatchObject({ cached: true, streamed: false, estimated: true });
  });

  it('summarises everything in the stream', async () => {
    const ledger = createRedisLedger(redis);
    await ledger.record(entry({ costUsd: 0.001, outcome: 'ok' }));
    await ledger.record(entry({ costUsd: 0.002, outcome: 'error', model: 'gpt-4o' }));

    const summary = await ledger.summary();
    expect(summary.entries).toBe(2);
    expect(summary.costUsd).toBe(0.003);
    expect(summary.byOutcome).toEqual({ ok: 1, error: 1 });
    expect(Object.keys(summary.byModel).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('returns the newest entries first', async () => {
    const ledger = createRedisLedger(redis);
    for (const id of ['one', 'two', 'three']) await ledger.record(entry({ requestId: id }));

    expect((await ledger.recent(2)).map((row) => row.requestId)).toEqual(['three', 'two']);
  });

  it('caps the stream so it cannot grow without bound', async () => {
    const ledger = createRedisLedger(redis, 5);
    for (let i = 0; i < 50; i += 1) await ledger.record(entry({ requestId: `r${String(i)}` }));

    // MAXLEN ~ trims on node boundaries, so the exact length is approximate —
    // the guarantee is that it stops growing, not that it lands on 5.
    const length = await redis.xlen(LEDGER_KEY);
    expect(length).toBeLessThan(50);
  });
});

describeWithRedis('rate limiter', () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  it('allows up to the limit and refuses past it', async () => {
    const limiter = createRateLimiter(redis, 3);
    const now = new Date('2026-09-06T12:00:10Z');

    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.check('key-a', now));

    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false]);
    expect(results[2]?.remaining).toBe(0);
  });

  it('counts each key separately', async () => {
    const limiter = createRateLimiter(redis, 1);
    const now = new Date('2026-09-06T12:00:10Z');

    expect((await limiter.check('key-a', now)).allowed).toBe(true);
    expect((await limiter.check('key-b', now)).allowed).toBe(true);
    expect((await limiter.check('key-a', now)).allowed).toBe(false);
  });

  it('starts a fresh window in the next minute', async () => {
    const limiter = createRateLimiter(redis, 1);
    expect((await limiter.check('key-c', new Date('2026-09-06T12:00:30Z'))).allowed).toBe(true);
    expect((await limiter.check('key-c', new Date('2026-09-06T12:00:45Z'))).allowed).toBe(false);
    expect((await limiter.check('key-c', new Date('2026-09-06T12:01:05Z'))).allowed).toBe(true);
  });

  it('reports a retry-after that lands inside the next window', async () => {
    const limiter = createRateLimiter(redis, 1);
    const decision = await limiter.check('key-d', new Date('2026-09-06T12:00:30Z'));
    expect(decision.retryAfterSeconds).toBe(30);
  });
});

describeWithRedis('caches against redis', () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  it('stores and returns an exact match', async () => {
    const cache = createExactCache(redis, 60);
    const input = { model: 'gpt-4o-mini', prompt: 'hello' };
    expect(await cache.get(input)).toBeNull();

    await cache.set(input, {
      text: 'stored',
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'gpt-4o-mini',
    });
    expect((await cache.get(input))?.text).toBe('stored');
  });

  it('never stores a sampled response', async () => {
    const cache = createExactCache(redis, 60);
    const input = { model: 'gpt-4o-mini', prompt: 'hello', temperature: 0.9 };

    await cache.set(input, {
      text: 'sampled',
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'gpt-4o-mini',
    });
    expect(await cache.get(input)).toBeNull();
    expect(await redis.dbsize()).toBe(0);
  });

  it('matches a near-identical prompt when semantic matching is on', async () => {
    // 0.5, not the 0.95 default. Cosine similarity is not on a universal
    // scale: the trigram stand-in scores this near-identical pair at ~0.71 and
    // the unrelated one at ~0.11, where a real embedding model would put both
    // much higher. The threshold has to be tuned to the embedder in use.
    const cache = createSemanticCache(redis, {
      ttlSeconds: 60,
      threshold: 0.5,
      embed: createDeterministicEmbedder(128),
    });

    await cache.set(
      { model: 'gpt-4o-mini', prompt: 'summarise the quarterly revenue report for the board' },
      {
        text: 'stored',
        usage: { promptTokens: 5, completionTokens: 5 },
        model: 'gpt-4o-mini',
      },
    );

    const near = await cache.get({
      model: 'gpt-4o-mini',
      prompt: 'summarise the quarterly revenue report for the board please',
    });
    expect(near?.text).toBe('stored');

    const unrelated = await cache.get({
      model: 'gpt-4o-mini',
      prompt: 'write a limerick about a cat that lost its hat',
    });
    expect(unrelated).toBeNull();
  });

  it('does not match across models', async () => {
    const cache = createSemanticCache(redis, {
      ttlSeconds: 60,
      threshold: 0.5,
      embed: createDeterministicEmbedder(128),
    });

    await cache.set(
      { model: 'gpt-4o-mini', prompt: 'the same question asked twice' },
      {
        text: 'mini answer',
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'gpt-4o-mini',
      },
    );

    // Two models are two different systems; a cached answer from one is not an
    // answer from the other.
    expect(
      await cache.get({ model: 'gpt-4o', prompt: 'the same question asked twice' }),
    ).toBeNull();
  });
});

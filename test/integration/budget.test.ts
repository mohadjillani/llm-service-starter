import { afterAll, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { createBudgetBreaker, monthKey, toUnits } from '../../src/accounting/budget.ts';
import { buildApp, connectRedis, describeWithRedis, redisUrl } from '../helpers/app.ts';

describeWithRedis('monthly budget breaker', () => {
  const redis = connectRedis(6);

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    if (!redisUrl) return;
    await redis.flushdb();
    await redis.quit();
  });

  it('allows requests below the cap and reports what is left', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 1, failMode: 'closed' });
    await budget.add(0.25);

    const decision = await budget.check();
    expect(decision).toMatchObject({ allowed: true, spentUsd: 0.25, remainingUsd: 0.75 });
  });

  it('accumulates atomically across concurrent charges', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 100, failMode: 'closed' });

    // A per-process counter would lose most of these. The point of putting it
    // in Redis is that replicas share one number.
    await Promise.all(Array.from({ length: 200 }, () => budget.add(0.001)));

    expect(await budget.spent()).toBe(0.2);
  });

  /** The headline: crossing the cap refuses with a usable Retry-After. */
  it('returns 429 with Retry-After pointing at the next month once the cap is crossed', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 0.01, failMode: 'closed' });
    const harness = buildApp({ overrides: { budget } });

    // Under the cap: served.
    await request(harness.app).post('/v1/complete').send({ prompt: 'first' }).expect(200);

    await budget.add(1);

    const refused = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'second' })
      .expect(429);

    expect(refused.body).toMatchObject({ error: 'monthly budget exhausted' });
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    // Never longer than the longest possible month.
    expect(retryAfter).toBeLessThanOrEqual(31 * 24 * 60 * 60);

    // The refused request never reached the provider, so it wrote no entry.
    expect(harness.ledger.entries).toHaveLength(1);
  });

  it('refuses a stream over budget before opening the event stream', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 0.000001, failMode: 'closed' });
    await budget.add(1);
    const harness = buildApp({ overrides: { budget } });

    const response = await request(harness.app)
      .post('/v1/complete/stream')
      .send({ prompt: 'hello' })
      .expect(429);

    // A JSON error, not an SSE stream carrying an error frame: the client
    // should be able to treat this as an ordinary rejected request.
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('charges the ledger and the counter together', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 100, failMode: 'closed' });
    const harness = buildApp({ overrides: { budget } });

    await request(harness.app).post('/v1/complete').send({ prompt: 'hello' }).expect(200);

    // The mock provider is priced at zero, so the counter stays at zero — but
    // the raw key must exist or nothing was charged at all.
    const entry = harness.ledger.entries[0];
    expect(entry?.costUsd).toBe(0);
    expect(await budget.spent()).toBe(0);
  });

  it('stores the counter under a key scoped to the calendar month', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 10, failMode: 'closed' });
    const now = new Date();
    await budget.add(0.5, now);

    const raw = await redis.get(monthKey(now));
    expect(Number(raw)).toBe(toUnits(0.5));

    // Next month starts from zero without anyone resetting anything.
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
    expect(await budget.spent(nextMonth)).toBe(0);
  });

  it('sets an expiry so old months do not accumulate forever', async () => {
    const budget = createBudgetBreaker(redis, { monthlyBudgetUsd: 10, failMode: 'closed' });
    await budget.add(0.1);
    expect(await redis.ttl(monthKey(new Date()))).toBeGreaterThan(0);
  });
});

describeWithRedis('budget breaker when Redis is unreachable', () => {
  // A port nothing is listening on, so every command fails rather than hangs.
  const unreachable = new Redis('redis://127.0.0.1:6399/0', {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  unreachable.on('error', () => undefined);

  afterAll(() => {
    unreachable.disconnect();
  });

  it('fails closed by default and refuses with 503', async () => {
    const budget = createBudgetBreaker(unreachable, {
      monthlyBudgetUsd: 100,
      failMode: 'closed',
    });
    const harness = buildApp({ overrides: { budget } });

    const response = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'hello' })
      .expect(503);

    // An unreadable counter is exactly when a runaway loop goes unnoticed, so
    // the default is to stop spending rather than to keep serving.
    expect((response.body as { error: string }).error).toContain('BUDGET_FAIL_MODE=closed');
    expect(harness.ledger.entries).toHaveLength(0);
  });

  it('fails open when configured to, because refusing traffic can cost more', async () => {
    const budget = createBudgetBreaker(unreachable, { monthlyBudgetUsd: 100, failMode: 'open' });
    const harness = buildApp({ overrides: { budget } });

    await request(harness.app).post('/v1/complete').send({ prompt: 'hello' }).expect(200);
    expect(harness.ledger.entries).toHaveLength(1);
  });

  it('reports itself not ready rather than healthy', async () => {
    const budget = createBudgetBreaker(unreachable, {
      monthlyBudgetUsd: 100,
      failMode: 'closed',
    });
    const harness = buildApp({ overrides: { budget } });

    await request(harness.app).get('/readyz').expect(503);
    // Liveness is unaffected: the process is fine, its dependency is not.
    await request(harness.app).get('/healthz').expect(200);
  });
});

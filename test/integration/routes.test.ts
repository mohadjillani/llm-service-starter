import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../helpers/app.ts';
import { createMockProvider, withRetry } from '../../src/providers/index.ts';
import type { Cache, CacheEntry } from '../../src/cache/index.ts';

function memoryCache(): Cache {
  const store = new Map<string, CacheEntry>();
  const key = (input: { model: string; prompt: string }) => `${input.model}:${input.prompt}`;
  return {
    get: (input) => Promise.resolve(store.get(key(input)) ?? null),
    set: (input, entry) => {
      store.set(key(input), entry);
      return Promise.resolve();
    },
  };
}

describe('POST /v1/complete', () => {
  it('returns a completion and records the spend', async () => {
    const harness = buildApp();
    const response = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'hello' })
      .expect(200);

    expect((response.body as { text: string }).text).toBeTypeOf('string');
    expect((response.body as { cached: boolean }).cached).toBe(false);
    expect(harness.ledger.entries).toHaveLength(1);
    // The mock prices itself at zero, so a demo run cannot look expensive.
    expect(harness.ledger.entries[0]?.costUsd).toBe(0);
  });

  it('serves a repeat request from the cache without calling the provider', async () => {
    let calls = 0;
    const provider = createMockProvider({ fixtures: ['cached answer'] });
    const counting = {
      ...provider,
      complete: (req: Parameters<typeof provider.complete>[0]) => {
        calls += 1;
        return provider.complete(req);
      },
    };

    const harness = buildApp({
      provider: withRetry(counting, { maxRetries: 0, timeoutMs: 5000 }),
      overrides: { cache: memoryCache() },
    });

    const first = await request(harness.app).post('/v1/complete').send({ prompt: 'x' }).expect(200);
    const second = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'x' })
      .expect(200);

    expect(calls).toBe(1);
    expect((second.body as { cached: boolean }).cached).toBe(true);
    expect((second.body as { text: string }).text).toBe((first.body as { text: string }).text);

    // A cache hit is still a request, and still gets a ledger entry — at zero
    // cost, so hit rate is visible in the ledger rather than invisible.
    expect(harness.ledger.entries).toHaveLength(2);
    expect(harness.ledger.entries[1]?.cached).toBe(true);
    expect(harness.ledger.entries[1]?.costUsd).toBe(0);
  });

  it('renders a versioned template', async () => {
    const harness = buildApp();
    await request(harness.app)
      .post('/v1/complete')
      .send({ template: 'summarize@v1', variables: { text: 'an article', max_words: 30 } })
      .expect(200);

    expect(harness.ledger.entries).toHaveLength(1);
  });

  it('rejects a template request with a bad variable rather than sending a broken prompt', async () => {
    const harness = buildApp();
    const response = await request(harness.app)
      .post('/v1/complete')
      .send({ template: 'summarize@v1', variables: { text: 'an article' } })
      .expect(400);

    expect((response.body as { error: string }).error).toBe('invalid template request');
    expect(harness.ledger.entries).toHaveLength(0);
  });

  it('rejects an unknown template version', async () => {
    const harness = buildApp();
    await request(harness.app)
      .post('/v1/complete')
      .send({ template: 'summarize@v9', variables: {} })
      .expect(400);
  });

  it('requires exactly one of prompt or template', async () => {
    const harness = buildApp();
    await request(harness.app).post('/v1/complete').send({}).expect(400);
    await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'a', template: 'summarize@v1' })
      .expect(400);
  });

  it('rejects an out-of-range temperature', async () => {
    const harness = buildApp();
    await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'hi', temperature: 5 })
      .expect(400);
  });

  it('surfaces an upstream failure with its status rather than a generic 500', async () => {
    const harness = buildApp({
      provider: withRetry(createMockProvider({ failTimes: 99, failStatus: 503 }), {
        maxRetries: 0,
        timeoutMs: 2000,
      }),
    });

    await request(harness.app).post('/v1/complete').send({ prompt: 'hi' }).expect(503);
    expect(harness.ledger.entries[0]?.outcome).toBe('error');
  });
});

describe('guards', () => {
  it('returns 429 with Retry-After when the key is rate limited', async () => {
    const harness = buildApp({
      overrides: {
        rateLimiter: {
          check: () => Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 42 }),
        },
      },
    });

    const response = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'hi' })
      .expect(429);

    expect(response.headers['retry-after']).toBe('42');
    expect(harness.ledger.entries).toHaveLength(0);
  });

  it('rejects a prompt the moderator refuses, before spending anything', async () => {
    const harness = buildApp({
      overrides: {
        moderator: () => Promise.resolve({ allowed: false, reason: 'too long' }),
      },
    });

    const response = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'hi' })
      .expect(422);

    expect((response.body as { detail: string }).detail).toBe('too long');
    expect(harness.ledger.entries).toHaveLength(0);
  });

  it('serves a cache hit without consulting the rate limiter', async () => {
    let rateChecks = 0;
    const cache = memoryCache();
    await cache.set(
      { model: 'gpt-4o-mini', prompt: 'known' },
      { text: 'stored', usage: { promptTokens: 1, completionTokens: 1 }, model: 'gpt-4o-mini' },
    );

    const harness = buildApp({
      overrides: {
        cache,
        rateLimiter: {
          check: () => {
            rateChecks += 1;
            return Promise.resolve({ allowed: true, remaining: 1, retryAfterSeconds: 60 });
          },
        },
      },
    });

    const response = await request(harness.app)
      .post('/v1/complete')
      .send({ prompt: 'known' })
      .expect(200);

    // A hit costs nothing upstream, so gating it on a limit that exists to
    // protect the upstream would refuse a request that needs no protecting.
    expect((response.body as { cached: boolean }).cached).toBe(true);
    expect(rateChecks).toBe(0);
  });
});

describe('operator endpoints', () => {
  it('reports the ledger summary and recent entries', async () => {
    const harness = buildApp();
    await request(harness.app).post('/v1/complete').send({ prompt: 'one' }).expect(200);
    await request(harness.app).post('/v1/complete').send({ prompt: 'two' }).expect(200);

    const response = await request(harness.app).get('/admin/ledger').expect(200);
    const ledgerView = response.body as {
      summary: { entries: number };
      recent: unknown[];
      budget: { allowed: boolean };
    };
    expect(ledgerView.summary.entries).toBe(2);
    expect(ledgerView.recent).toHaveLength(2);
    expect(ledgerView.budget.allowed).toBe(true);
  });

  it('never puts a raw api key in the ledger', async () => {
    const harness = buildApp();
    await request(harness.app)
      .post('/v1/complete')
      .set('x-api-key', 'sk-super-secret-value')
      .send({ prompt: 'hi' })
      .expect(200);

    const entry = harness.ledger.entries[0];
    expect(entry?.apiKey).not.toContain('super-secret');
    expect(entry?.apiKey).toBe('…alue');
  });

  it('lists the prompt templates it knows', async () => {
    const harness = buildApp();
    const response = await request(harness.app).get('/v1/prompts').expect(200);
    const ids = (response.body as { templates: { id: string }[] }).templates.map(
      (template) => template.id,
    );
    expect(ids).toContain('summarize@v1');
    expect(ids).toContain('summarize@v2');
  });

  it('reports healthy', async () => {
    const harness = buildApp();
    const response = await request(harness.app).get('/healthz').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', provider: 'mock' });
  });
});

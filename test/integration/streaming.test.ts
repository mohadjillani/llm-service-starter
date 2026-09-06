import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp, listen, type Listening } from '../helpers/app.ts';
import { createMockProvider, withRetry } from '../../src/providers/index.ts';

const LONG = Array.from({ length: 60 }, (_, i) => `token${String(i)}`).join(' ');

let running: Listening | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('streaming', () => {
  it('opens before the first token so nothing waits on a slow start', async () => {
    const harness = buildApp({
      provider: withRetry(createMockProvider({ fixtures: ['one two three'] }), {
        maxRetries: 0,
        timeoutMs: 5000,
      }),
    });

    const response = await request(harness.app)
      .post('/v1/complete/stream')
      .send({ prompt: 'hello' })
      .expect(200)
      .expect('content-type', /text\/event-stream/);

    const body = response.text;
    expect(body.indexOf('event: open')).toBeLessThan(body.indexOf('event: delta'));
    expect(body).toContain('event: done');
    // A buffering proxy would hold the whole stream and defeat the point.
    expect(response.headers['x-accel-buffering']).toBe('no');
  });

  it('records one ledger entry with the usage the provider reported', async () => {
    const harness = buildApp({
      provider: withRetry(createMockProvider({ fixtures: ['alpha beta gamma'] }), {
        maxRetries: 0,
        timeoutMs: 5000,
      }),
    });

    await request(harness.app).post('/v1/complete/stream').send({ prompt: 'hi' }).expect(200);

    expect(harness.ledger.entries).toHaveLength(1);
    const entry = harness.ledger.entries[0];
    expect(entry?.outcome).toBe('ok');
    expect(entry?.streamed).toBe(true);
    expect(entry?.estimated).toBe(false);
    expect(entry?.completionTokens).toBeGreaterThan(0);
  });

  /**
   * The headline case: a client that goes away mid-stream.
   *
   * Three things have to hold. The upstream call is cancelled, so the provider
   * stops generating rather than finishing an answer nobody will read. No
   * tokens are produced after the abort. And exactly one ledger entry is
   * written, marked aborted — a stream that was half delivered still consumed
   * tokens, and a ledger that only records completed requests understates the
   * bill exactly when something is going wrong.
   */
  it('cancels upstream when the client disconnects, and still records the spend', async () => {
    const provider = createMockProvider({ fixtures: [LONG], tokenDelayMs: 15 });
    let tokensProducedByProvider = 0;

    const counting = {
      ...provider,
      async *stream(req: Parameters<typeof provider.stream>[0]) {
        for await (const event of provider.stream(req)) {
          if (event.type === 'delta') tokensProducedByProvider += 1;
          yield event;
        }
      },
    };

    const harness = buildApp({
      provider: withRetry(counting, { maxRetries: 0, timeoutMs: 10_000 }),
    });
    running = await listen(harness.app);

    const controller = new AbortController();
    const response = await fetch(`${running.url}/v1/complete/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a long answer please' }),
      signal: controller.signal,
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('the server sent no body');

    // Read a few frames, then vanish the way a closed browser tab does.
    let reads = 0;
    while (reads < 3) {
      const { done } = await reader.read();
      if (done) break;
      reads += 1;
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Let the server observe the close and finish its bookkeeping.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const producedAtAbort = tokensProducedByProvider;

    // Nothing more is generated once the client is gone.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(tokensProducedByProvider).toBe(producedAtAbort);

    // The fixture is 60 tokens; stopping early is the whole point.
    expect(tokensProducedByProvider).toBeLessThan(60);

    expect(harness.ledger.entries).toHaveLength(1);
    expect(harness.ledger.entries[0]?.outcome).toBe('aborted');
    expect(harness.ledger.entries[0]?.streamed).toBe(true);
  });

  it('does not cache a response the client abandoned', async () => {
    const seen: string[] = [];
    const cache = {
      get: () => Promise.resolve(null),
      set: (input: { prompt: string }) => {
        seen.push(input.prompt);
        return Promise.resolve();
      },
    };

    const harness = buildApp({
      provider: withRetry(createMockProvider({ fixtures: [LONG], tokenDelayMs: 15 }), {
        maxRetries: 0,
        timeoutMs: 10_000,
      }),
      overrides: { cache },
    });
    running = await listen(harness.app);

    const controller = new AbortController();
    const response = await fetch(`${running.url}/v1/complete/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'abandoned' }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Storing a truncated answer would serve it to the next caller as if it
    // were complete.
    expect(seen).not.toContain('abandoned');
  });

  it('reports an upstream failure as an SSE error rather than a dead connection', async () => {
    const harness = buildApp({
      provider: withRetry(createMockProvider({ failTimes: 99, failStatus: 500 }), {
        maxRetries: 0,
        timeoutMs: 5000,
      }),
    });

    const response = await request(harness.app)
      .post('/v1/complete/stream')
      .send({ prompt: 'hi' })
      .expect(200);

    expect(response.text).toContain('event: error');
    expect(harness.ledger.entries[0]?.outcome).toBe('error');
  });
});

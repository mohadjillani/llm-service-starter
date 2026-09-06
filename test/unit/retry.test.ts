import { describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  backoffDelay,
  createMockProvider,
  isRetryable,
  withRetry,
  type StreamEvent,
} from '../../src/providers/index.ts';

const noSleep = () => Promise.resolve();

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const always = () => 1;
    expect(backoffDelay(0, 200, 8000, always)).toBe(200);
    expect(backoffDelay(1, 200, 8000, always)).toBe(400);
    expect(backoffDelay(2, 200, 8000, always)).toBe(800);
    expect(backoffDelay(10, 200, 8000, always)).toBe(8000);
  });

  it('picks a point inside the window rather than the window itself', () => {
    // Full jitter: a fixed schedule re-synchronises every client that hit the
    // same rate limit, so the delay must actually vary.
    expect(backoffDelay(3, 200, 8000, () => 0)).toBe(0);
    expect(backoffDelay(3, 200, 8000, () => 0.5)).toBe(800);
  });
});

describe('isRetryable', () => {
  it('retries transport failures only', () => {
    expect(isRetryable(new ProviderError('rate limited', 429, true))).toBe(true);
    expect(isRetryable(new ProviderError('bad request', 400, false))).toBe(false);
    expect(isRetryable(new Error('something else'))).toBe(false);
  });
});

describe('withRetry — complete', () => {
  it('retries a transient failure and succeeds', async () => {
    const provider = withRetry(createMockProvider({ failTimes: 2, failStatus: 503 }), {
      maxRetries: 3,
      timeoutMs: 1000,
      sleep: noSleep,
    });

    const result = await provider.complete({ model: 'gpt-4o-mini', prompt: 'hello' });
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('gives up after maxRetries and reports the last failure', async () => {
    const provider = withRetry(createMockProvider({ failTimes: 10, failStatus: 503 }), {
      maxRetries: 2,
      timeoutMs: 1000,
      sleep: noSleep,
    });

    await expect(provider.complete({ model: 'gpt-4o-mini', prompt: 'hello' })).rejects.toThrow(
      ProviderError,
    );
  });

  it('does not retry a non-retryable failure', async () => {
    const onAttempt = vi.fn();
    const provider = withRetry(createMockProvider({ failTimes: 1, failStatus: 400 }), {
      maxRetries: 3,
      timeoutMs: 1000,
      sleep: noSleep,
      onAttempt,
    });

    // The mock marks everything retryable, so drive the policy directly.
    const base = createMockProvider();
    const rejecting = withRetry(
      {
        ...base,
        complete: () => Promise.reject(new ProviderError('bad request', 400, false)),
      },
      { maxRetries: 3, timeoutMs: 1000, sleep: noSleep, onAttempt },
    );

    await expect(rejecting.complete({ model: 'gpt-4o-mini', prompt: 'hi' })).rejects.toThrow(
      'bad request',
    );
    expect(onAttempt).not.toHaveBeenCalled();
    expect(provider.name).toBe('mock');
  });

  it('times out an attempt that never answers', async () => {
    const provider = withRetry(createMockProvider({ stallMs: 5_000 }), {
      maxRetries: 0,
      timeoutMs: 30,
      sleep: noSleep,
    });

    await expect(provider.complete({ model: 'gpt-4o-mini', prompt: 'hi' })).rejects.toThrow();
  });
});

describe('withRetry — stream', () => {
  it('retries before the first token', async () => {
    const provider = withRetry(createMockProvider({ failTimes: 2, failStatus: 503 }), {
      maxRetries: 3,
      timeoutMs: 1000,
      sleep: noSleep,
    });

    const events = await collect(provider.stream({ model: 'gpt-4o-mini', prompt: 'hello' }));
    expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('does not retry once a token has been delivered', async () => {
    let attempts = 0;
    const base = createMockProvider();
    const flakyMidStream = withRetry(
      {
        ...base,
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream(): AsyncIterable<StreamEvent> {
          attempts += 1;
          yield { type: 'delta', text: 'first ' };
          throw new ProviderError('connection reset', undefined, true);
        },
      },
      { maxRetries: 5, timeoutMs: 1000, sleep: noSleep },
    );

    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of flakyMidStream.stream({ model: 'gpt-4o-mini', prompt: 'hi' })) {
          seen.push(event);
        }
      })(),
    ).rejects.toThrow('connection reset');

    // One attempt only. Retrying here would append a second answer to the half
    // the client already holds.
    expect(attempts).toBe(1);
    expect(seen).toEqual([{ type: 'delta', text: 'first ' }]);
  });

  it('stops when the caller aborts and does not treat it as retryable', async () => {
    const controller = new AbortController();
    const provider = withRetry(createMockProvider({ tokenDelayMs: 20 }), {
      maxRetries: 3,
      timeoutMs: 1000,
      sleep: noSleep,
    });

    const events: StreamEvent[] = [];
    const pump = (async () => {
      for await (const event of provider.stream({
        model: 'gpt-4o-mini',
        prompt: 'hello there friend',
        signal: controller.signal,
      })) {
        events.push(event);
        if (events.length === 2) controller.abort();
      }
    })();

    await pump.catch(() => undefined);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.type).not.toBe('done');
  });
});

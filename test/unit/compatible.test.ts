import { describe, expect, it } from 'vitest';
import { createCompatibleProvider } from '../../src/providers/compatible.ts';
import { ProviderError, type StreamEvent } from '../../src/providers/types.ts';
import { createBasicModerator } from '../../src/middleware/moderation.ts';
import { keyFingerprint } from '../../src/telemetry/logger.ts';
import { parseConfig } from '../../src/config.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('openai-compatible provider', () => {
  it('posts to /chat/completions under the configured base url', async () => {
    let seenUrl = '';
    const provider = createCompatibleProvider({
      baseURL: 'http://localhost:1234/v1/',
      fetchImpl: (input) => {
        seenUrl = input instanceof URL ? input.href : (input as string);
        return Promise.resolve(
          jsonResponse({ model: 'local', choices: [{ message: { content: 'hi' } }] }),
        );
      },
    });

    const result = await provider.complete({ model: 'local', prompt: 'hello' });
    // The trailing slash on the base URL must not produce a doubled one.
    expect(seenUrl).toBe('http://localhost:1234/v1/chat/completions');
    expect(result.text).toBe('hi');
  });

  it('estimates usage when the endpoint does not report it', async () => {
    const provider = createCompatibleProvider({
      baseURL: 'http://localhost:1234/v1',
      fetchImpl: () =>
        Promise.resolve(jsonResponse({ choices: [{ message: { content: 'a reply' } }] })),
    });

    const result = await provider.complete({ model: 'local', prompt: 'hello there' });
    // Recording zero would make an unmetered endpoint look free.
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('prefers reported usage when it is there', async () => {
    const provider = createCompatibleProvider({
      baseURL: 'http://localhost:1234/v1',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({
            choices: [{ message: { content: 'x' } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
        ),
    });

    const result = await provider.complete({ model: 'local', prompt: 'hello' });
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 22 });
  });

  it('marks a 503 retryable and a 400 not', async () => {
    const make = (status: number) =>
      createCompatibleProvider({
        baseURL: 'http://localhost:1234/v1',
        fetchImpl: () => Promise.resolve(new Response('upstream said no', { status })),
      });

    await expect(make(503).complete({ model: 'local', prompt: 'x' })).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
    await expect(make(400).complete({ model: 'local', prompt: 'x' })).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
  });

  it('treats a network failure as retryable', async () => {
    const provider = createCompatibleProvider({
      baseURL: 'http://localhost:1234/v1',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(provider.complete({ model: 'local', prompt: 'x' })).rejects.toMatchObject({
      retryable: true,
      status: undefined,
    });
  });

  it('parses SSE frames that arrive split across chunks', async () => {
    const provider = createCompatibleProvider({
      baseURL: 'http://localhost:1234/v1',
      fetchImpl: () =>
        Promise.resolve(
          sseResponse([
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta"',
            ':{"content":"lo"}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
        ),
    });

    const events = await collect(provider.stream({ model: 'local', prompt: 'hi' }));
    const text = events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join('');

    // A frame split mid-JSON must not be dropped or double-counted.
    expect(text).toBe('Hello');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('falls back to an estimate when a stream carries no usage', async () => {
    const provider = createCompatibleProvider({
      baseURL: 'http://localhost:1234/v1',
      fetchImpl: () =>
        Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'])),
    });

    const events = await collect(provider.stream({ model: 'local', prompt: 'hi' }));
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.usage?.completionTokens).toBeGreaterThan(0);
  });

  it('sends an authorization header only when a key is configured', async () => {
    const headersSeen: Record<string, string>[] = [];
    const capture = (init?: RequestInit) => {
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: '' } }] }));
    };

    await createCompatibleProvider({
      baseURL: 'http://x/v1',
      fetchImpl: (_input, init) => capture(init),
    }).complete({ model: 'local', prompt: 'x' });

    await createCompatibleProvider({
      baseURL: 'http://x/v1',
      apiKey: 'secret',
      fetchImpl: (_input, init) => capture(init),
    }).complete({ model: 'local', prompt: 'x' });

    expect(headersSeen[0]?.authorization).toBeUndefined();
    expect(headersSeen[1]?.authorization).toBe('Bearer secret');
  });

  it('reports a body with no stream as retryable rather than crashing', async () => {
    const provider = createCompatibleProvider({
      baseURL: 'http://x/v1',
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    await expect(collect(provider.stream({ model: 'local', prompt: 'x' }))).rejects.toThrow(
      ProviderError,
    );
  });
});

describe('basic moderator', () => {
  it('rejects an empty prompt', async () => {
    expect(await createBasicModerator()('   ')).toMatchObject({ allowed: false });
  });

  it('rejects a prompt past the ceiling', async () => {
    const moderate = createBasicModerator({ maxPromptChars: 10 });
    expect(await moderate('this is definitely longer than ten')).toMatchObject({ allowed: false });
    expect(await moderate('short')).toEqual({ allowed: true });
  });
});

describe('key fingerprint', () => {
  it('keeps only the last four characters', () => {
    expect(keyFingerprint('sk-live-abcdefgh')).toBe('…efgh');
  });

  it('does not leak a short key by showing all of it', () => {
    expect(keyFingerprint('abcd')).toBe('anonymous');
  });
});

describe('configuration', () => {
  it('applies defaults', () => {
    const config = parseConfig({});
    expect(config).toMatchObject({ PROVIDER: 'mock', BUDGET_FAIL_MODE: 'closed', PORT: 3000 });
  });

  it('refuses PROVIDER=openai with no key, at boot rather than at request time', () => {
    expect(() => parseConfig({ PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY is required/);
  });

  it('refuses PROVIDER=compatible with no base url', () => {
    expect(() => parseConfig({ PROVIDER: 'compatible' })).toThrow(/OPENAI_BASE_URL is required/);
  });

  it('rejects a nonsense value rather than coercing it', () => {
    expect(() => parseConfig({ MONTHLY_BUDGET_USD: 'lots' })).toThrow(/invalid configuration/);
    expect(() => parseConfig({ BUDGET_FAIL_MODE: 'maybe' })).toThrow(/invalid configuration/);
  });

  it('accepts a fully specified openai configuration', () => {
    const config = parseConfig({ PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', MODEL: 'gpt-4o' });
    expect(config.MODEL).toBe('gpt-4o');
  });
});

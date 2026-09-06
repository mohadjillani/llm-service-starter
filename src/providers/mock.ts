import { ProviderError, type CompletionRequest, type Provider, type StreamEvent } from './types.ts';

export interface MockOptions {
  /** Replies, replayed in order and then repeated from the start. */
  fixtures?: string[];
  /** Fail this many calls before the first success. */
  failTimes?: number;
  /** Status the injected failures carry. */
  failStatus?: number;
  /** Delay before the first token, for testing timeouts and disconnects. */
  stallMs?: number;
  /** Delay between streamed tokens. */
  tokenDelayMs?: number;
}

const DEFAULT_FIXTURES = [
  'The service returned a deterministic reply from the mock provider.',
  'A second fixture, so replaying more than one call is visible.',
];

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('aborted', undefined, false));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('aborted', undefined, false));
      },
      { once: true },
    );
  });

/**
 * A provider with no network behind it.
 *
 * Everything this service does around a model — retries, budget accounting,
 * caching, streaming, cancellation — is behaviour of this service, not of the
 * model. Making all of it exercisable without an API key means the test suite
 * is deterministic, free, and runnable by anyone who clones the repository,
 * which is a large part of why the provider is an interface at all.
 */
export function createMockProvider(options: MockOptions = {}): Provider {
  const fixtures = options.fixtures?.length ? options.fixtures : DEFAULT_FIXTURES;
  let calls = 0;
  let replies = 0;

  function nextReply(): string {
    const reply = fixtures[replies % fixtures.length] ?? '';
    replies += 1;
    return reply;
  }

  function failIfConfigured(): void {
    calls += 1;
    if (options.failTimes !== undefined && calls <= options.failTimes) {
      const status = options.failStatus ?? 503;
      throw new ProviderError(
        `mock failure ${String(calls)} of ${String(options.failTimes)}`,
        status,
        true,
      );
    }
  }

  // Roughly four characters per token: close enough for a mock, and the real
  // adapters use a real tokenizer.
  const countTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

  return {
    name: 'mock',

    async complete(request: CompletionRequest) {
      failIfConfigured();
      if (options.stallMs) await sleep(options.stallMs, request.signal);
      const text = nextReply();
      return {
        text,
        model: request.model,
        usage: {
          promptTokens: countTokens(request.prompt),
          completionTokens: countTokens(text),
        },
      };
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      failIfConfigured();
      if (options.stallMs) await sleep(options.stallMs, request.signal);

      const text = nextReply();
      const tokens = text.split(/(?<=\s)/);
      let emitted = 0;

      for (const token of tokens) {
        // Checked before each token so a disconnect stops the stream promptly
        // rather than after the whole fixture has been produced.
        if (request.signal?.aborted) return;
        if (options.tokenDelayMs) await sleep(options.tokenDelayMs, request.signal);
        emitted += 1;
        yield { type: 'delta', text: token };
      }

      yield {
        type: 'done',
        usage: {
          promptTokens: countTokens(request.prompt),
          completionTokens: emitted,
        },
      };
    },

    countTokens,

    pricing() {
      // Priced at zero so a demo run cannot look like it cost money.
      return {
        inputPerMillion: 0,
        outputPerMillion: 0,
        source: 'mock provider — no cost',
        asOf: '2026-08',
      };
    },
  };
}

import { ProviderError, type CompletionRequest, type Provider, type StreamEvent } from './types.ts';

export interface RetryOptions {
  maxRetries: number;
  /** Applies per attempt, and for a stream only until the first token. */
  timeoutMs: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onAttempt?: (event: { attempt: number; error: unknown; delayMs: number }) => void;
  /** Injectable so tests are not at the mercy of a random number. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  // A thrown DOMException from an abort is a decision, not a failure.
  if (error instanceof Error && error.name === 'AbortError') return false;
  return false;
}

/**
 * Full jitter: sleep for a random point in [0, exponential backoff].
 *
 * Retrying a rate limit on a fixed schedule synchronises every client that hit
 * the limit at the same moment, so they all come back together and hit it
 * again. Spreading them across the window is the point — the expected delay is
 * halved, which is a fair trade for not rebuilding the thundering herd.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new ProviderError(`no response within ${String(timeoutMs)}ms`, 408, true));
  }, timeoutMs);

  const signals = signal ? [signal, controller.signal] : [controller.signal];
  return {
    signal: AbortSignal.any(signals),
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Wraps a provider with a per-attempt timeout and jittered exponential backoff.
 *
 * Only transport-level failures are retried: 408, 429, 5xx and network errors.
 * A 400 or a content refusal is a fact about the request — repeating it burns
 * money and quota to get the same answer.
 */
export function withRetry(provider: Provider, options: RetryOptions): Provider {
  const {
    maxRetries,
    timeoutMs,
    baseDelayMs = 200,
    maxDelayMs = 8_000,
    random = Math.random,
    sleep = defaultSleep,
    onAttempt,
  } = options;

  async function pause(attempt: number, error: unknown): Promise<void> {
    const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
    onAttempt?.({ attempt: attempt + 1, error, delayMs });
    await sleep(delayMs);
  }

  return {
    name: provider.name,
    countTokens: provider.countTokens.bind(provider),
    pricing: provider.pricing.bind(provider),

    async complete(request: CompletionRequest) {
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const guard = withTimeout(request.signal, timeoutMs);
        try {
          return await provider.complete({ ...request, signal: guard.signal });
        } catch (error) {
          lastError = error;
          // The caller's own signal firing is a cancellation, not a failure.
          if (request.signal?.aborted) throw error;
          if (!isRetryable(error) || attempt === maxRetries) throw error;
          await pause(attempt, error);
        } finally {
          guard.clear();
        }
      }

      throw lastError;
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      for (let attempt = 0; ; attempt += 1) {
        const guard = withTimeout(request.signal, timeoutMs);
        let delivered = false;

        try {
          for await (const event of provider.stream({ ...request, signal: guard.signal })) {
            if (event.type === 'delta') {
              // Time-to-first-token is what the timeout is for; a long answer
              // is not a stalled one, so the guard is released here rather
              // than covering the whole stream.
              if (!delivered) guard.clear();
              delivered = true;
            }
            yield event;
          }
          return;
        } catch (error) {
          // Once bytes are on the wire the response cannot be retried: the
          // client has half an answer, and a second attempt would append a
          // different one to it. Fail instead, and let the caller decide.
          if (delivered) throw error;
          if (request.signal?.aborted) throw error;
          if (!isRetryable(error) || attempt >= maxRetries) throw error;
          await pause(attempt, error);
        } finally {
          guard.clear();
        }
      }
    },
  };
}

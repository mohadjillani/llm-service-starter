import type { Config } from '../config.ts';
import { createCompatibleProvider } from './compatible.ts';
import { createMockProvider } from './mock.ts';
import { createOpenAiProvider } from './openai.ts';
import { withRetry } from './retry.ts';
import type { Provider } from './types.ts';

export * from './types.ts';
export { createMockProvider } from './mock.ts';
export { createCompatibleProvider } from './compatible.ts';
export { createOpenAiProvider } from './openai.ts';
export { withRetry, backoffDelay, isRetryable } from './retry.ts';

/**
 * Builds the configured provider and wraps it in the retry policy.
 *
 * The retry wrapper is applied here rather than inside each adapter so that all
 * three behave identically under failure — the mock provider's injected 503 is
 * retried by exactly the code that retries a real one.
 */
export function createProvider(config: Config): Provider {
  const base = ((): Provider => {
    switch (config.PROVIDER) {
      case 'openai':
        return createOpenAiProvider({
          apiKey: config.OPENAI_API_KEY ?? '',
          baseURL: config.OPENAI_BASE_URL,
        });
      case 'compatible':
        return createCompatibleProvider({
          baseURL: config.OPENAI_BASE_URL ?? '',
          apiKey: config.OPENAI_API_KEY,
        });
      case 'mock':
        return createMockProvider();
    }
  })();

  return withRetry(base, {
    maxRetries: config.MAX_RETRIES,
    timeoutMs: config.REQUEST_TIMEOUT_MS,
  });
}

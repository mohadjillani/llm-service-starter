import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The streaming suites start real servers and the Redis suites share one
    // database index; running files in parallel makes both flaky.
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // server.ts is the process entry point and the real OpenAI adapter needs
      // a key, so neither is reachable from the suite that runs everywhere.
      exclude: [
        'src/server.ts',
        'src/dependencies.ts',
        'src/providers/openai.ts',
        'src/**/index.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

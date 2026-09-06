import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createRuntime } from './dependencies.ts';

const config = loadConfig();
const runtime = createRuntime(config);
const app = createApp(runtime.deps);

const server = app.listen(config.PORT, () => {
  runtime.deps.logger.info(
    {
      port: config.PORT,
      provider: runtime.deps.provider.name,
      model: config.MODEL,
      cache: config.CACHE_MODE,
      budgetUsd: config.MONTHLY_BUDGET_USD,
      failMode: config.BUDGET_FAIL_MODE,
    },
    'listening',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runtime.deps.logger.info({ signal }, 'shutting down');
    // Stop accepting connections, let in-flight streams finish, then release
    // Redis. A stream cut off at shutdown still has a ledger entry, but the
    // client loses the tail of an answer it has already been charged for.
    server.close(() => {
      void runtime.close().then(() => {
        process.exit(0);
      });
    });
  });
}

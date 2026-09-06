import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createMemoryLedger } from '../src/accounting/ledger.ts';
import { createBasicModerator } from '../src/middleware/moderation.ts';
import { createPromptRegistry } from '../src/prompts/registry.ts';
import { createMockProvider, withRetry } from '../src/providers/index.ts';

/**
 * Runs a handful of requests against the mock provider and prints the ledger.
 *
 * No Redis and no API key: the point is to show the shape of what the service
 * records, and to make the README's sample output something anyone can
 * reproduce with one command.
 */
async function main(): Promise<number> {
  const config = parseConfig({ PROVIDER: 'mock', LOG_LEVEL: 'silent' });
  const ledger = createMemoryLedger();

  // An in-memory cache so a repeat request demonstrates a hit without Redis.
  const store = new Map<
    string,
    { text: string; usage: { promptTokens: number; completionTokens: number }; model: string }
  >();
  const cache = {
    get: (input: { model: string; prompt: string }) =>
      Promise.resolve(store.get(`${input.model}:${input.prompt}`) ?? null),
    set: (
      input: { model: string; prompt: string },
      entry: {
        text: string;
        usage: { promptTokens: number; completionTokens: number };
        model: string;
      },
    ) => {
      store.set(`${input.model}:${input.prompt}`, entry);
      return Promise.resolve();
    },
  };

  const app = createApp({
    config,
    provider: withRetry(
      createMockProvider({
        fixtures: [
          'The line reopens on Monday after signalling work; reduced frequency for a week.',
          'Migration moved 4.2m rows in eleven hours, limited by replica lag, with no failed requests.',
          'The office moves to the third floor on Friday.',
        ],
      }),
      { maxRetries: 2, timeoutMs: 5000 },
    ),
    cache,
    ledger,
    budget: {
      check: () => Promise.resolve({ allowed: true, spentUsd: 0, remainingUsd: 50 }),
      add: () => Promise.resolve(),
      spent: () => Promise.resolve(0),
    },
    rateLimiter: {
      check: () => Promise.resolve({ allowed: true, remaining: 60, retryAfterSeconds: 60 }),
    },
    moderator: createBasicModerator(),
    prompts: createPromptRegistry(),
    logger: pino({ level: 'silent' }),
  });

  console.log('provider: mock (no API key, no Redis)\n');

  const prompts = [
    { label: 'plain prompt', body: { prompt: 'Summarise the transport notice.' } },
    {
      label: 'template summarize@v1',
      body: {
        template: 'summarize@v1',
        variables: { text: 'A long migration report.', max_words: 40 },
      },
    },
    {
      label: 'template summarize@v2',
      body: {
        template: 'summarize@v2',
        variables: { text: 'A long migration report.', max_words: 40 },
      },
    },
  ];

  for (const { label, body } of prompts) {
    const response = await request(app).post('/v1/complete').send(body);
    const parsed = response.body as { text?: string; cached?: boolean };
    console.log(`${label.padEnd(24)} ${String(response.status)}  cached=${String(parsed.cached)}`);
    console.log(`  ${parsed.text ?? ''}\n`);
  }

  // The same plain prompt again: served from the cache, at no cost.
  const repeat = await request(app)
    .post('/v1/complete')
    .send({ prompt: 'Summarise the transport notice.' });
  console.log(
    `repeat of the first     ${String(repeat.status)}  cached=${String(
      (repeat.body as { cached?: boolean }).cached,
    )}\n`,
  );

  const streamed = await request(app)
    .post('/v1/complete/stream')
    .send({ prompt: 'Stream something back.' });
  const frames = streamed.text.split('\n\n').filter(Boolean).length;
  console.log(`streamed request        ${String(streamed.status)}  ${String(frames)} SSE frames\n`);

  const summary = await ledger.summary();
  console.log('ledger summary:');
  console.log(`  requests          ${String(summary.entries)}`);
  console.log(`  prompt tokens     ${String(summary.promptTokens)}`);
  console.log(`  completion tokens ${String(summary.completionTokens)}`);
  console.log(`  cost              $${summary.costUsd.toFixed(6)}  (mock provider is priced at 0)`);
  console.log(`  by outcome        ${JSON.stringify(summary.byOutcome)}`);

  return 0;
}

process.exitCode = await main();

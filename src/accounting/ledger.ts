import type { Redis } from 'ioredis';

export interface LedgerEntry {
  at: string;
  requestId: string;
  apiKey: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Null when the model is not in the pricing table. */
  costUsd: number | null;
  /** True when the cost figure came from a local estimate, not from the API. */
  estimated: boolean;
  cached: boolean;
  streamed: boolean;
  outcome: 'ok' | 'error' | 'aborted';
}

export interface LedgerSummary {
  entries: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  byModel: Record<string, { entries: number; costUsd: number }>;
  byOutcome: Record<string, number>;
}

export interface Ledger {
  record(entry: LedgerEntry): Promise<void>;
  recent(limit: number): Promise<LedgerEntry[]>;
  summary(): Promise<LedgerSummary>;
}

export const LEDGER_KEY = 'ledger:entries';

function emptySummary(): LedgerSummary {
  return {
    entries: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    byModel: {},
    byOutcome: {},
  };
}

function accumulate(summary: LedgerSummary, entry: LedgerEntry): void {
  summary.entries += 1;
  summary.promptTokens += entry.promptTokens;
  summary.completionTokens += entry.completionTokens;
  summary.costUsd = Number((summary.costUsd + (entry.costUsd ?? 0)).toFixed(8));

  const model = (summary.byModel[entry.model] ??= { entries: 0, costUsd: 0 });
  model.entries += 1;
  model.costUsd = Number((model.costUsd + (entry.costUsd ?? 0)).toFixed(8));

  summary.byOutcome[entry.outcome] = (summary.byOutcome[entry.outcome] ?? 0) + 1;
}

function toFields(entry: LedgerEntry): string[] {
  return [
    'at',
    entry.at,
    'requestId',
    entry.requestId,
    'apiKey',
    entry.apiKey,
    'provider',
    entry.provider,
    'model',
    entry.model,
    'promptTokens',
    String(entry.promptTokens),
    'completionTokens',
    String(entry.completionTokens),
    'costUsd',
    entry.costUsd === null ? '' : String(entry.costUsd),
    'estimated',
    String(entry.estimated),
    'cached',
    String(entry.cached),
    'streamed',
    String(entry.streamed),
    'outcome',
    entry.outcome,
  ];
}

function fromFields(fields: string[]): LedgerEntry {
  const map = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 2) {
    map.set(fields[i] ?? '', fields[i + 1] ?? '');
  }
  const cost = map.get('costUsd') ?? '';
  return {
    at: map.get('at') ?? '',
    requestId: map.get('requestId') ?? '',
    apiKey: map.get('apiKey') ?? '',
    provider: map.get('provider') ?? '',
    model: map.get('model') ?? '',
    promptTokens: Number(map.get('promptTokens') ?? '0'),
    completionTokens: Number(map.get('completionTokens') ?? '0'),
    costUsd: cost === '' ? null : Number(cost),
    estimated: map.get('estimated') === 'true',
    cached: map.get('cached') === 'true',
    streamed: map.get('streamed') === 'true',
    outcome: (map.get('outcome') ?? 'ok') as LedgerEntry['outcome'],
  };
}

/**
 * A Redis stream, capped at a fixed length.
 *
 * A stream rather than a list because entries are append-only and read by
 * range, and because a consumer group can be added later without changing how
 * they are written. The cap is approximate (`MAXLEN ~`) so trimming happens on
 * whole nodes instead of costing something on every append.
 *
 * This is the small end of the design. The ledger is the record of what was
 * spent, and anything that has to survive a Redis restart or be queried over
 * months belongs in a database — see docs/adr/0004.
 */
export function createRedisLedger(redis: Redis, maxLength = 10_000): Ledger {
  return {
    async record(entry) {
      await redis.xadd(LEDGER_KEY, 'MAXLEN', '~', String(maxLength), '*', ...toFields(entry));
    },

    async recent(limit) {
      const rows = await redis.xrevrange(LEDGER_KEY, '+', '-', 'COUNT', limit);
      return rows.map(([, fields]) => fromFields(fields));
    },

    async summary() {
      const summary = emptySummary();
      // Reads the whole stream. Fine at the capped length, and the reason the
      // cap exists; a service keeping months of history needs a rollup instead.
      const rows = await redis.xrange(LEDGER_KEY, '-', '+');
      for (const [, fields] of rows) accumulate(summary, fromFields(fields));
      return summary;
    },
  };
}

/** Used by tests and by `npm run demo`, so neither needs Redis. */
export function createMemoryLedger(): Ledger & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
      return Promise.resolve();
    },
    recent(limit) {
      return Promise.resolve(entries.slice(-limit).reverse());
    },
    summary() {
      const summary = emptySummary();
      for (const entry of entries) accumulate(summary, entry);
      return Promise.resolve(summary);
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  UNITS_PER_USD,
  fromUnits,
  monthKey,
  secondsUntilNextMonth,
  toUnits,
} from '../../src/accounting/budget.ts';
import { costOf, knownModels, priceFor } from '../../src/accounting/pricing.ts';
import { createMemoryLedger } from '../../src/accounting/ledger.ts';

describe('budget units', () => {
  it('round-trips a sub-cent amount without drift', () => {
    const cost = 0.00000123;
    expect(fromUnits(toUnits(cost))).toBe(cost);
  });

  it('accumulates a thousand sub-cent charges exactly', () => {
    // The same additions in floating point drift; the counter must not.
    let units = 0;
    for (let i = 0; i < 1000; i += 1) units += toUnits(0.0000001);
    expect(units).toBe(10_000);
    expect(fromUnits(units)).toBe(0.0001);
  });

  it('uses hundred-millionths, matching the precision costs are rounded to', () => {
    expect(UNITS_PER_USD).toBe(100_000_000);
  });
});

describe('monthKey and secondsUntilNextMonth', () => {
  it('keys by UTC calendar month', () => {
    expect(monthKey(new Date('2026-09-06T22:00:00Z'))).toBe('budget:2026-09');
    expect(monthKey(new Date('2026-01-01T00:00:00Z'))).toBe('budget:2026-01');
  });

  it('counts to the start of the next month', () => {
    const oneDayLeft = new Date('2026-09-30T00:00:00Z');
    expect(secondsUntilNextMonth(oneDayLeft)).toBe(86_400);
  });

  it('rolls over a year boundary', () => {
    expect(secondsUntilNextMonth(new Date('2026-12-31T23:59:00Z'))).toBe(60);
  });

  it('never returns zero, so Retry-After is always meaningful', () => {
    expect(secondsUntilNextMonth(new Date('2026-09-30T23:59:59.999Z'))).toBeGreaterThan(0);
  });
});

describe('pricing', () => {
  it('prices a known model from the dated table', () => {
    const price = priceFor('gpt-4o-mini');
    expect(price?.inputPerMillion).toBeGreaterThan(0);
    expect(price?.source).toContain('openai.com');
    expect(price?.asOf).toBe('2026-08');
  });

  it('returns null rather than guessing at an unknown model', () => {
    expect(priceFor('not-a-real-model')).toBeNull();
    expect(costOf('not-a-real-model', { promptTokens: 100, completionTokens: 100 })).toBeNull();
  });

  it('computes cost from the per-million rates', () => {
    const price = priceFor('gpt-4o-mini');
    const cost = costOf('gpt-4o-mini', { promptTokens: 1_000_000, completionTokens: 0 });
    expect(cost).toBe(price?.inputPerMillion);
  });

  it('keeps sub-cent precision instead of rounding it away', () => {
    const cost = costOf('gpt-4o-mini', { promptTokens: 10, completionTokens: 10 });
    expect(cost).toBeGreaterThan(0);
  });

  it('lists the models it knows', () => {
    expect(knownModels()).toContain('gpt-4o-mini');
  });
});

describe('ledger summary', () => {
  it('totals tokens, cost and outcomes', async () => {
    const ledger = createMemoryLedger();
    const base = {
      at: new Date().toISOString(),
      requestId: 'r',
      apiKey: '…abcd',
      provider: 'mock',
      estimated: false,
      cached: false,
      streamed: false,
    };

    await ledger.record({
      ...base,
      model: 'gpt-4o-mini',
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.001,
      outcome: 'ok',
    });
    await ledger.record({
      ...base,
      model: 'gpt-4o-mini',
      promptTokens: 20,
      completionTokens: 0,
      costUsd: 0.002,
      outcome: 'error',
    });
    await ledger.record({
      ...base,
      model: 'gpt-4o',
      promptTokens: 1,
      completionTokens: 1,
      costUsd: null,
      outcome: 'aborted',
    });

    const summary = await ledger.summary();
    expect(summary.entries).toBe(3);
    expect(summary.promptTokens).toBe(31);
    expect(summary.costUsd).toBe(0.003);
    expect(summary.byModel['gpt-4o-mini']?.entries).toBe(2);
    expect(summary.byOutcome).toEqual({ ok: 1, error: 1, aborted: 1 });
  });

  it('returns the most recent entries first', async () => {
    const ledger = createMemoryLedger();
    for (const id of ['a', 'b', 'c']) {
      await ledger.record({
        at: new Date().toISOString(),
        requestId: id,
        apiKey: 'k',
        provider: 'mock',
        model: 'gpt-4o-mini',
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        estimated: false,
        cached: false,
        streamed: false,
        outcome: 'ok',
      });
    }
    const recent = await ledger.recent(2);
    expect(recent.map((entry) => entry.requestId)).toEqual(['c', 'b']);
  });
});

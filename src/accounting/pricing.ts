import { readFileSync } from 'node:fs';
import type { Price, Usage } from '../providers/types.ts';

interface PricingTable {
  asOf: string;
  source: string;
  models: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
}

/**
 * Read at startup rather than imported, so the path resolves the same way from
 * `src/` under tsx and from `dist/` in the built image — both sit one level
 * below the repository root.
 */
const pricing = JSON.parse(
  readFileSync(new URL('../../pricing/2026-08.json', import.meta.url), 'utf8'),
) as PricingTable;

/**
 * Prices are a versioned file, not constants in code.
 *
 * The number that priced a request last month has to stay available to explain
 * a ledger entry from last month, so a change means a new file rather than an
 * edit to this one. `asOf` and `source` travel with every price so a figure can
 * always be traced back to where it was read from.
 */
export function priceFor(model: string): Price | null {
  const entry = pricing.models[model];
  if (!entry) return null;
  return {
    inputPerMillion: entry.inputPerMillion,
    outputPerMillion: entry.outputPerMillion,
    source: pricing.source,
    asOf: pricing.asOf,
  };
}

export function knownModels(): string[] {
  return Object.keys(pricing.models);
}

/** Cost in US dollars from a price the provider supplied. */
export function costFromPrice(price: Price | null, usage: Usage): number | null {
  if (!price) return null;
  const input = (usage.promptTokens / 1_000_000) * price.inputPerMillion;
  const output = (usage.completionTokens / 1_000_000) * price.outputPerMillion;
  // Sub-cent amounts are the normal case, so round to a precision that keeps
  // them rather than to two decimal places.
  return Number((input + output).toFixed(8));
}

/**
 * Cost for a model in the shipped table.
 *
 * Callers that have a provider should ask the provider instead — the mock
 * prices itself at zero, and pricing it off this table would make a demo run
 * look like it spent money.
 */
export function costOf(model: string, usage: Usage): number | null {
  return costFromPrice(priceFor(model), usage);
}

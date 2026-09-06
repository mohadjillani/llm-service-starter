import type { Redis } from 'ioredis';

/**
 * Costs are accumulated as integers.
 *
 * A month of sub-cent floating-point additions drifts, and the number being
 * drifted is the one deciding whether to refuse requests. Everything is stored
 * in hundred-millionths of a dollar — the precision `costOf` rounds to — so the
 * counter is exact and `INCRBY` stays atomic.
 */
export const UNITS_PER_USD = 100_000_000;

export function toUnits(usd: number): number {
  return Math.round(usd * UNITS_PER_USD);
}

export function fromUnits(units: number): number {
  return Number((units / UNITS_PER_USD).toFixed(8));
}

export function monthKey(now: Date): string {
  return `budget:${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Seconds until the start of the next UTC month — the Retry-After value. */
export function secondsUntilNextMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export type BudgetDecision =
  | { allowed: true; spentUsd: number; remainingUsd: number }
  | { allowed: false; reason: 'over-budget'; spentUsd: number; retryAfterSeconds: number }
  | { allowed: false; reason: 'unavailable'; retryAfterSeconds: number };

export interface BudgetBreaker {
  check(now?: Date): Promise<BudgetDecision>;
  add(costUsd: number, now?: Date): Promise<void>;
  spent(now?: Date): Promise<number>;
}

export interface BudgetOptions {
  monthlyBudgetUsd: number;
  failMode: 'closed' | 'open';
  /** Retained for a month past the month it covers, then dropped. */
  ttlSeconds?: number;
}

/**
 * A spending cap for the calendar month, backed by an atomic Redis counter.
 *
 * The counter is authoritative across every instance, which is the point:
 * a per-process budget is not a budget, it is a budget multiplied by however
 * many replicas happen to be running.
 *
 * When Redis cannot answer, the default is to refuse. An unavailable counter is
 * exactly when a runaway loop goes unnoticed, and the failure this exists to
 * prevent is an unbounded bill rather than a failed request. Setting
 * BUDGET_FAIL_MODE=open inverts that, for services where refusing traffic costs
 * more than the tokens would.
 */
export function createBudgetBreaker(redis: Redis, options: BudgetOptions): BudgetBreaker {
  const limitUnits = toUnits(options.monthlyBudgetUsd);
  const ttl = options.ttlSeconds ?? 60 * 60 * 24 * 40;

  return {
    async check(now = new Date()) {
      let spentUnits: number;
      try {
        const raw = await redis.get(monthKey(now));
        spentUnits = raw === null ? 0 : Number.parseInt(raw, 10);
        if (Number.isNaN(spentUnits)) spentUnits = 0;
      } catch {
        if (options.failMode === 'open') {
          return { allowed: true, spentUsd: 0, remainingUsd: options.monthlyBudgetUsd };
        }
        return { allowed: false, reason: 'unavailable', retryAfterSeconds: 30 };
      }

      if (spentUnits >= limitUnits) {
        return {
          allowed: false,
          reason: 'over-budget',
          spentUsd: fromUnits(spentUnits),
          retryAfterSeconds: secondsUntilNextMonth(now),
        };
      }

      return {
        allowed: true,
        spentUsd: fromUnits(spentUnits),
        remainingUsd: fromUnits(limitUnits - spentUnits),
      };
    },

    async add(costUsd, now = new Date()) {
      const units = toUnits(costUsd);
      if (units <= 0) return;
      const key = monthKey(now);
      // Charged after the fact, so a request that lands exactly on the limit is
      // allowed and the next one is refused. Reserving up front would need the
      // completion length before it exists, and would have to be reconciled or
      // released on every failure path.
      const total = await redis.incrby(key, units);
      // Only set on the first write of the month; a bare EXPIRE each time would
      // keep pushing the expiry out.
      if (total === units) await redis.expire(key, ttl);
    },

    async spent(now = new Date()) {
      const raw = await redis.get(monthKey(now));
      return raw === null ? 0 : fromUnits(Number.parseInt(raw, 10));
    },
  };
}

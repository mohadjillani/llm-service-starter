# ADR 0003: Costs accumulate as integers in a shared counter

**Status:** accepted · **Date:** 2026-09-06

## Context

The budget breaker adds a number to a running total on every request and refuses
traffic once that total crosses a cap. Both halves of that are easy to get
subtly wrong.

Individual request costs are small — a few hundred tokens of `gpt-4o-mini` is
around `0.00006` dollars. A month of adding numbers like that in binary floating
point accumulates error, and the number accumulating error is the one deciding
whether to stop spending.

The total also has to mean something across more than one process. A counter
held in memory is not a budget: with six replicas it is six budgets.

## Decision

Costs are stored as integers — hundred-millionths of a dollar, the precision
`costFromPrice` rounds to — in a single Redis key per calendar month,
incremented with `INCRBY`.

Integers remove the drift entirely rather than bounding it, and `INCRBY` is
atomic, so concurrent requests across every replica accumulate into one exact
total. The key expires forty days after the month it covers, so old months
disappear without anyone maintaining them.

Spend is charged **after** the request rather than reserved before it. Reserving
would need the completion length before it exists, and every failure path would
then have to release or reconcile the reservation — including the paths that
exist because something already went wrong.

## Consequences

The counter is exact and shared. `test/integration/budget.test.ts` fires two
hundred concurrent charges and asserts the total to the last unit; a per-process
counter would lose most of them.

Charging afterwards means the request that crosses the limit is allowed and the
next one is refused, so the cap can be overshot by one request's cost. For a cap
denominated in tens of dollars and requests costing fractions of a cent, that is
not worth the complexity of reservations.

It also means a request whose cost cannot be recorded — Redis unavailable
mid-flight — is spent but unaccounted for. That is logged at error level, and
under the default fail-closed mode the request would not have been allowed to
start; see ADR 0006.

Pricing is a dated file rather than constants, so a ledger entry from a previous
month stays explicable: a price change adds a file rather than editing one.

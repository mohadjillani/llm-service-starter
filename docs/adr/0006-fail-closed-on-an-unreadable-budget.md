# ADR 0006: Fail closed when the budget counter cannot be read

**Status:** accepted · **Date:** 2026-09-06

## Context

The budget breaker reads a Redis counter before every request. Redis will
sometimes be unavailable. The service then has to choose between refusing
traffic it might have been able to afford, and serving traffic it might not.

The usual instinct for a dependency that is not the primary data store is to
degrade gracefully and keep serving. That instinct is right for a cache and
wrong here.

## Decision

Refuse, by default, with 503. `BUDGET_FAIL_MODE=open` inverts it.

The asymmetry is in what each mistake costs. Failing closed when there was
budget available means some requests are rejected for as long as Redis is down —
recoverable, visible, and over when the dependency comes back. Failing open when
the budget was already exhausted means unbounded spend for the same period, and
the amount is bounded only by how long nobody notices.

An unreadable counter also correlates with the situation that most needs a cap.
A runaway retry loop hammering the service is exactly the kind of load that
takes Redis with it, and that is the worst moment to remove the spending limit.

The Redis client is configured with `maxRetriesPerRequest: 2` and no offline
queue so a check _fails_ rather than hanging. A breaker that blocks is a breaker
that does not work.

## Consequences

Redis becomes a hard dependency of serving traffic under the default
configuration, which is a real reduction in availability and is stated plainly
in the README rather than buried. `/readyz` reports the service as not ready
when the counter is unreadable, so an orchestrator stops routing to it, while
`/healthz` stays up because the process itself is fine.

`BUDGET_FAIL_MODE=open` exists because the trade genuinely goes the other way
for some services — a support assistant that fails is worse than one that
overspends by a few dollars. The choice is configuration rather than a code
change precisely because it depends on the deployment, not on the code.

Under fail-open, a request whose cost cannot be recorded is spent and
unaccounted for. That is logged at error level and is an accepted consequence of
choosing to keep serving.

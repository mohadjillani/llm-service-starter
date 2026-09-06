# ADR 0002: Retries stop once a stream has started

**Status:** accepted · **Date:** 2026-09-06

## Context

Rate limits and transient upstream failures are common enough that a service
which does not retry will drop requests it did not need to drop. Retrying is
therefore not optional. The question is what may be retried and when.

Two things make this harder than the usual case. Every attempt costs money, so
retrying the wrong class of error spends real budget to receive the same
rejection. And a streamed response has already delivered part of an answer to
the client by the time it fails.

## Decision

Retry on 408, 429, 5xx and network-level failures only, with full-jitter
exponential backoff, a per-attempt timeout — and never after the first streamed
token.

**Only transport failures.** A 400, a validation error, a content refusal: these
are facts about the request. Repeating them produces the same answer and a
second charge.

**Full jitter, not a fixed schedule.** Every client that hit the same rate limit
hit it at roughly the same moment. Backing off by a fixed amount brings them all
back together to hit it again. Sleeping for a random point in `[0, backoff]`
spreads them out; halving the expected delay is a fair price for not rebuilding
the herd.

**The timeout covers time-to-first-token, not the whole stream.** A long answer
is not a stalled one, and a single timeout over the entire response would kill
exactly the requests that are working hardest.

**No retry after the first token.** This is the one that is easy to get wrong,
because the retry looks harmless from the server's side. It is not: the client
already holds the first half of one answer, and a fresh attempt would append the
middle of a different one. The result is a response that is syntactically fine
and semantically nonsense.

## Consequences

A stream that dies at token two fails, visibly, rather than being silently
repaired into something incoherent. Clients that want a retry can reissue the
request, which is a decision they are in a position to make and the server is
not.

`test/unit/retry.test.ts` asserts the attempt count directly, so a change that
"helpfully" retries mid-stream fails there rather than in production.

Idempotency keys would let a mid-stream retry resume rather than restart. That
is a real answer to this problem and it is not implemented here — it needs the
provider to support resumption, which none currently do.

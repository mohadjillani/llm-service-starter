# ADR 0004: The ledger is a capped Redis stream, and is not the system of record

**Status:** accepted · **Date:** 2026-09-06

## Context

Every request needs a durable line saying what it cost, for three different
audiences: an operator asking why the bill moved, a developer asking whether the
cache is working, and a future rollup that attributes spend to a customer.

The obvious homes are a Redis structure, a relational table, or the log stream
the service already produces.

## Decision

A Redis stream capped at ten thousand entries, behind a two-method interface.

A stream rather than a list because entries are append-only and read by range,
and because a consumer group can be added later — shipping entries into a
warehouse — without changing how they are written. The cap uses `MAXLEN ~` so
trimming happens on whole nodes rather than costing something on every append.

The interface matters more than the implementation. `record` and `summary` are
all the service needs, so replacing Redis with PostgreSQL touches one file.

## Consequences

The ledger survives a restart, is queryable from `/admin/ledger` without any
extra infrastructure, and is the same shape whether it is backed by Redis or by
the in-memory implementation the tests and `npm run demo` use.

**It is explicitly not a system of record**, and the cap is what makes that
honest rather than hiding it. Ten thousand entries is hours of traffic, not
months. `summary` reads the whole stream, which is fine at that length and would
not be at a hundred times it. A service that needs spend attributed per customer
over a quarter needs a database and a rollup job; this is the thing that tells
you today what today cost.

The other consequence is that a cache hit still gets an entry, at zero cost. It
would be cheaper to skip it, but then the hit rate — the number that says
whether the cache is worth having — would be invisible in the only place anyone
looks.

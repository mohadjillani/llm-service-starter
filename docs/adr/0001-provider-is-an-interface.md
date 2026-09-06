# ADR 0001: The provider is an interface, and the mock is a first-class implementation

**Status:** accepted · **Date:** 2026-09-06

## Context

Almost everything in this service is a decision about how to _call_ a model
rather than about the model itself: when to retry, when to stop retrying, what a
request cost, whether to serve a stored answer, what to do when the client
hangs up. All of that is testable — but only if a test can produce a 503, a
stall, or a stream that dies after its second token on demand.

The options were to call the real API in tests, to mock the HTTP layer with
`nock` or similar, or to make the provider an interface and ship a real
implementation that fakes the model.

## Decision

A four-method `Provider` interface — `complete`, `stream`, `countTokens`,
`pricing` — with three implementations: the official SDK, a raw-fetch adapter
for OpenAI-shaped endpoints, and a mock that replays fixtures and can be told to
fail _n_ times, to stall, or to emit tokens slowly.

The retry policy wraps whichever one is configured, so the mock's injected 503
is retried by exactly the code that retries a real one. That is the property
that makes the mock worth having: it is not a stub standing in for the code
under test, it is a substitute for the network underneath it.

`pricing` is on the interface rather than being a lookup in a shared table so
that the mock can price itself at zero. A demo run cannot then look as though it
spent money.

## Consequences

The whole suite runs with no API key, costs nothing, and is deterministic — so
it runs on every push rather than nightly, and a contributor without a key can
still change the retry policy with confidence.

The cost is a boundary to keep honest: the mock cannot tell anyone whether the
real API behaves as assumed. The `openai` adapter is therefore excluded from
coverage thresholds rather than being fake-tested to make a number go up, and
the README says plainly that it is the least exercised part of the repository.

The interface also has to be the _narrow_ part. Anything provider-specific that
leaks through it — an SDK type in a signature, a provider's error class — would
make the mock progressively less able to stand in for the others.

# Contributing

## Running the checks

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Everything runs with no API key — the mock provider covers every path the
service owns. Suites that need Redis skip visibly without it:

```sh
REDIS_URL=redis://127.0.0.1:6379/6 npm test
```

Coverage thresholds are enforced, and are only reachable with Redis running.
CI runs the full suite in a job with a Redis service container.

## Seeing it work

```sh
npm run demo     # five requests against the mock, then the ledger
npm run eval     # regenerates docs/eval-report.md
```

## Changing a prompt

Never edit a template in place. Add `name@vN+1.md` alongside it, leave the old
one loadable, and run `npm run eval` — the committed report is checked in CI and
a stale one fails the build. The reasoning is in
[ADR 0005](docs/adr/0005-prompts-are-versioned-files.md).

## Changing the retry policy

`test/unit/retry.test.ts` asserts attempt counts rather than outcomes, on
purpose. If a change makes one of those fail, read the assertion before changing
it — several of them encode decisions that look like bugs from close up,
particularly the refusal to retry a stream that has already sent a token.

## Adding a provider

Implement `Provider` in `src/providers/`, add it to the factory in
`src/providers/index.ts`, and extend the `PROVIDER` enum in `src/config.ts`. Do
not add retry logic inside the adapter — the wrapper applies to all of them, and
duplicating it there would make the mock stop being a faithful stand-in.

Anything provider-specific that leaks into the interface makes the mock less
useful. Keep SDK types out of the signatures.

## Commit style

Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`) with a
body explaining _why_ when the change is not self-evident.

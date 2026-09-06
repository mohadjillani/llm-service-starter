# Architecture decision records

- [0001 — The provider is an interface, and the mock is a first-class implementation](0001-provider-is-an-interface.md)
- [0002 — Retries stop once a stream has started](0002-retries-stop-at-the-first-token.md)
- [0003 — Costs accumulate as integers in a shared counter](0003-costs-are-integers.md)
- [0004 — The ledger is a capped Redis stream, and is not the system of record](0004-ledger-is-a-capped-stream.md)
- [0005 — Prompts are versioned files, and requests name the version](0005-prompts-are-versioned-files.md)
- [0006 — Fail closed when the budget counter cannot be read](0006-fail-closed-on-an-unreadable-budget.md)

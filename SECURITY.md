# Security

## What this is

A starter template. It has no authentication of its own — `x-api-key` is used to
attribute spend and rate limits, and is not verified against anything. Put it
behind something that authenticates before exposing it.

## Handling of the provider key

- Read from the environment and validated at boot. `PROVIDER=openai` without
  `OPENAI_API_KEY` refuses to start rather than failing on the first request.
- Never logged. The logger redacts `authorization` and `x-api-key` headers, and
  the ledger stores only the last four characters of a caller's key
  (`…efgh`) — enough to answer "which key was this", not enough to reuse.
- Not present in the image. The Dockerfile copies no `.env`, and
  `.dockerignore` excludes it.

## Prompt injection

Template variables are interpolated into the prompt. **Any text a user controls
that reaches a variable is attacker-controlled input to the model**, and nothing
here defends against that — a variable containing "ignore previous instructions"
is passed through verbatim.

What the template system does provide is a smaller surface: the _structure_ of
the prompt is a file in the repository, and only declared variables are
substituted. A caller cannot supply the instruction block, only fill the slots.
That prevents a caller rewriting the prompt wholesale; it does not prevent them
influencing the model through the slot they are given.

If the output of this service triggers actions — calling tools, writing to a
database, sending mail — treat the model's response as untrusted input and
validate it at that boundary, not here.

## Logging and redaction

Prompts are redacted from logs by default. They are user content and frequently
contain personal data, and a log aggregator is usually a wider audience than the
service itself. Removing that redaction is a deliberate choice with privacy
consequences, not a debugging convenience.

## Denial of wallet

The failure mode specific to this kind of service is spend rather than downtime.
Three things bound it, and all three are configuration:

- `MONTHLY_BUDGET_USD` — a hard cap for the calendar month, shared across
  replicas.
- `RATE_LIMIT_PER_MINUTE` — per key, so one caller cannot consume the budget.
- `MAX_RETRIES` — each attempt is charged; the default of 3 means a request can
  cost up to four times its nominal price.

`BUDGET_FAIL_MODE` defaults to `closed`, so an unreadable counter stops spending
rather than removing the cap. See
[ADR 0006](docs/adr/0006-fail-closed-on-an-unreadable-budget.md).

## Reporting

Open an issue, or email mohad.jillani@gmail.com for anything that should not be
public first.

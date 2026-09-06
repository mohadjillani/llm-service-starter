# Runbook

## The service is returning 429 and nobody is being rate limited

Check which 429 it is. The body distinguishes them:

```json
{ "error": "monthly budget exhausted", "retry_after": 1382400, "spent_usd": 50.02 }
{ "error": "rate limit exceeded", "retry_after": 37 }
```

A budget 429 means the calendar-month cap has been reached. `Retry-After` points
at the start of next month, which is honest but rarely what anyone wants to hear.

```sh
curl -s localhost:3000/admin/ledger | python3 -m json.tool | head -30
```

The summary breaks spend down by model, so a single expensive model or a change
of default is usually visible immediately. To raise the cap, change
`MONTHLY_BUDGET_USD` and restart; to reset the counter deliberately — knowing
that this discards the record of what has been spent:

```sh
redis-cli DEL "budget:$(date -u +%Y-%m)"
```

## The service is returning 503 with "budget counter unavailable"

Redis is unreachable and `BUDGET_FAIL_MODE=closed`. This is the designed
behaviour, not a bug — see [ADR 0006](adr/0006-fail-closed-on-an-unreadable-budget.md).

```sh
redis-cli -u "$REDIS_URL" ping
curl -s localhost:3000/readyz
```

Fix Redis. If the service must keep serving while that happens, and overspending
is the lesser evil for this deployment, set `BUDGET_FAIL_MODE=open` and restart —
and remember to set it back.

## Spend jumped and nobody changed anything

In order of likelihood:

1. **Cache hit rate collapsed.** `byOutcome` and the `cached` flag in
   `/admin/ledger` show it. A cache is only used for requests at temperature 0;
   a client that started sending `temperature: 0.7` stops hitting it entirely,
   by design.
2. **A prompt template changed.** `npm run eval` reports what each version costs
   to send. A more detailed instruction block is charged on every call.
3. **The model default changed.** `byModel` in the summary shows the split.
4. **Retries.** Each attempt is charged. A provider having a bad hour multiplies
   spend by up to `MAX_RETRIES + 1` for the affected requests.

## Streams hang or truncate

- A proxy that buffers will hold the entire response. The service sends
  `x-accel-buffering: no` and an `open` event before the first token; if the
  client sees neither, something in between is buffering.
- `REQUEST_TIMEOUT_MS` bounds time-to-first-token, not the whole stream. A
  stream that starts and then stops is an upstream failure and arrives as an
  `event: error` frame.
- A stream that fails after its first token is not retried, deliberately —
  [ADR 0002](adr/0002-retries-stop-at-the-first-token.md).

## A client disconnected but we were still charged

Expected, and correct. Tokens generated before the disconnect were produced and
billed by the provider. The service cancels the upstream call as soon as the
client goes away, so the charge stops growing, and records one ledger entry with
`outcome: "aborted"` so the spend is visible rather than lost.

```sh
curl -s localhost:3000/admin/ledger | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d['summary']['byOutcome'])"
```

A rising `aborted` count usually means clients are timing out before the model
finishes — check the completion length, not the service.

## Rolling a prompt back

Versions are files and every version stays loaded. There is nothing to deploy:
point the caller at the previous id.

```sh
curl -s localhost:3000/v1/prompts        # what is loaded
# then send {"template":"summarize@v1", ...} instead of v2
```

## Updating prices

`pricing/<YYYY-MM>.json` is a hand-taken snapshot, not a feed. When list prices
change, add a new file and point `src/accounting/pricing.ts` at it — do not edit
the old one, or last month's ledger entries stop being explicable.

Cost is `null`, not zero, for a model missing from the table. That distinction is
deliberate: an unpriced request must not look free.

## What changes

## Why

## If this touches prompts

- [ ] New version added as a file; the previous version still loads
- [ ] `npm run eval` re-run and `docs/eval-report.md` committed

## If this touches retries, budgets or streaming

- [ ] The relevant assertion in `test/unit/retry.test.ts` or
      `test/integration/` still holds, and was read rather than adjusted
- [ ] Cost accounting still produces exactly one ledger entry per request

## Checks

- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] `REDIS_URL=... npm test` (coverage thresholds need Redis)

# Logging

The service logs structured JSON at every entrypoint.

- **HTTP requests** go through Fastify's Pino logger (`LOG_LEVEL` controls
  verbosity; `request.log` adds `reqId`, `req`, `res` and `responseTime`).
- **Non-request code** — the indexer, its CLI entrypoints, and the cursor
  writer — writes through the `StructuredLogger` in `src/lib/logger.ts`. Every
  line is one JSON object: `level`, `time` (ISO-8601), `msg`, plus
  caller-supplied fields. The `msg` text is still human-readable, so an
  operator watching `npm run reindex` sees the same lines as before; the
  fields (`processed`, `total`, `pct`, `ratePerSec`, `etaSec`, …) are what a
  log aggregator can query.

Set `LOG_LEVEL` for the Fastify logger (`trace`/`debug`/`info`/`warn`/`error`/
`fatal`/`silent`; defaults to `info`). The `StructuredLogger` has no level
gate: every call is emitted.

## Stable event names for alerting

Message patterns are stable interfaces — build alerts on these, not on the
whole line (fields are appended and wording may gain detail).

| Message pattern | Severity | Meaning |
|---|---|---|
| `[indexer] LEDGER DISCONTINUITY DETECTED` | `error` | Reorg or chain fork detected — the indexer has halted. Confirm chain state, then `npm run reindex`. See README "Reorg detection". |
| `[indexer] quarantined event` | `error` | A handler failed deterministically and the event was isolated. Check `/api/admin/failed-events`. See README "Quarantine". |
| `[indexer] Cursor write failed` | `error` | **A page folded successfully, but persisting the cursor failed afterwards.** The derived tables are correct up to `lastLedger`; the cursor just can't record it. The next poll refetches the same page, which is safe (raw events are idempotent on their id), so this usually self-heals — but if it repeats, the indexer re-folds the same page forever and `/ready` can report `indexer_stale` even though folding works. Distinct from `[indexer] poll error` (the RPC call failed, so *nothing* folded) and from `indexer_stale` (the cursor is merely idle). Investigate the database (locks, connection limits, disk) when it persists. |
| `[indexer] poll error` | `error` | `getEvents`/RPC failed (transient network issue or RPC outage). Includes consecutive failure count and backoff delay. Resolves automatically on recovery. Unlike a cursor-write failure, no work was folded for that poll. |
| `[indexer] CONTRACT_ID changed` | `warn` | Contract redeployment detected with `INDEXER_RESET_ON_CONTRACT_CHANGE=true`. Derived tables will be wiped. |
| `[db] applied migration` | `info` | A database migration was applied successfully. Normal on first boot after a schema change. |
| `[db] migration failed` | `error` | A migration failed to apply. Process will exit. Requires manual intervention. |
| `[auth] signature verification failed` | `warn` | An authentication attempt with an invalid signature. Normal for misconfigured clients; repeated failures from one IP may indicate an attack. |
| `[stream] client error` | `error` | A Server-Sent Events stream client encountered an error. Client will reconnect. |

The `/ready` endpoint's `indexer_stale` response is the HTTP-visible twin of
the freshness signal — it is not a log line, but it is alertable the same way
(non-200 from `/ready`).

## CLI progress lines

`npm run reindex` reports progress and completion through the
`StructuredLogger` (issue #531):

```json
{"level":"info","time":"2026-01-01T00:00:00.000Z","msg":"[reindex] progress: 1000/5000 event(s) (20.00%) — 812.4 events/s, eta 4s","processed":1000,"total":5000,"pct":20,"ratePerSec":812.4,"etaSec":4}
{"level":"info","time":"2026-01-01T00:00:01.000Z","msg":"[reindex] rebuilt derived tables from 5000 event(s)","events":5000}
```

Query completed runs with `select(.msg | startswith("[reindex] rebuilt"))`, or
track throughput with `select(.fields? // . | .processed)` in your aggregator.

## Example queries

```bash
# Everything from one indexer poll failure
jq 'select(.msg | contains("[indexer] poll error"))' < app.log

# Cursor-write failures only — folded-but-not-recorded
jq 'select(.event == "cursor_write_failed")' < app.log

# Reindex throughput lines
jq 'select(.msg | startswith("[reindex] progress:")) | {processed, total, ratePerSec}' < app.log
```

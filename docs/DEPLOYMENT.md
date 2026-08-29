# Deployment guide

This document covers everything needed to run `ourdao-backend` outside a laptop: the two-process topology, first-deploy decisions, configuration, backup, redeploy, and day-to-day operations. It deliberately omits platform-specific manifests — the requirements below map to any container scheduler or VM.

> **Living document.** Several open issues in this repo change deployment-relevant behaviour: leader election for the worker (#TBD), Docker/readiness improvements, and migration tooling. This document will be updated as those land. Where a known gap exists it is called out inline.

## Table of contents

- [Two-process topology](#two-process-topology)
- [The image](#the-image)
- [First deploy: the cold-start decision](#first-deploy-the-cold-start-decision)
- [Required configuration](#required-configuration)
- [Full configuration reference](#full-configuration-reference)
- [Database connections](#database-connections)
- [Backup and recovery](#backup-and-recovery)
- [Redeploying the contract](#redeploying-the-contract)
- [Operations](#operations)
- [Related repos](#related-repos)

---

## Two-process topology

```
Soroban RPC
     │
     ▼  poll getEvents
┌──────────┐          ┌──────────┐
│  worker  │──writes──▶ Postgres ◀──reads──│   API   │──▶ frontend
│ (×1 only)│          └──────────┘         │  (×N)   │
└──────────┘
```

The backend is two separate processes sharing one Postgres database.

**API** (`node dist/index.js`) is stateless and horizontally scalable. Run as many instances as load requires. Each instance migrates the database on boot (idempotent, serialized by a Postgres advisory lock) and opens a pool of database connections.

**Worker** (`node dist/worker.js`) is the indexer: it polls the Soroban RPC for new contract events, writes them to the append-only `events` log, and folds each event into the derived tables (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) inside a single database transaction. It also migrates on boot.

### The worker must be a singleton

**Run exactly one worker at a time. Running two or more corrupts data silently.**

The folding operations are non-idempotent: vote tallies are incremented, contribution balances are adjusted, and notification rows are inserted each time an event is processed. If two workers process the same event page concurrently, each one increments the tally independently — the result is a number higher than the true on-chain value, with no error, no warning, and no way to detect it after the fact short of a full reindex. Unlike most "don't run two" warnings, this one has no database-level guard; the corruption is silent and accumulates.

The safe pattern is:
- **One worker process.** No auto-scaling, no redundant replicas for the worker.
- **Restart-safe.** The worker persists its resume position in `indexer_cursor`. A crashed worker can be restarted safely — it will resume from where it left off. A clean shutdown waits up to 10 seconds for the current page to finish before closing the database pool.
- **Leader election is a known gap.** If you need the worker to survive a host failure automatically (e.g. in a container scheduler that might reschedule it), there is currently no leader-election mechanism to prevent two workers from running briefly in parallel during a handoff. See the open issue in this repo. Until it lands, treat the worker as a pet: restart it manually or ensure the scheduler enforces at-most-one with a hard stop before starting a replacement.

---

## The image

Both processes run from the same Docker image. The default `CMD` starts the API; override it for the worker:

```bash
# Build
docker build -t ourdao-backend .

# API (default CMD)
docker run --env-file .env -p 4000:4000 ourdao-backend

# Worker (CMD override)
docker run --env-file .env ourdao-backend node dist/worker.js

# One-off reindex (see Backup and recovery)
docker run --env-file .env ourdao-backend node dist/indexer/reindex.js
```

The image runs as the non-root `node` user with `tini` as PID 1. `tini` handles signal forwarding and zombie reaping — both are required for the worker's graceful shutdown to work. The `HEALTHCHECK` targets `GET /health` (a no-DB liveness check) rather than `/ready` (which does a DB round-trip and reports `503` when the indexer is behind — useful as a readiness probe in an orchestrator, not a container health signal).

**Do not run the worker with a health check that restarts it on `503` from `/ready`.** If the indexer falls behind for any reason (RPC hiccup, a slow page), `/ready` returns `503` and a health check targeting it would kill and restart the worker in a loop, losing its place and creating exactly the restart storm that compounds the problem. Use `/health` for container health and `/ready` as a readiness/load-balancer probe on the API only.

---

## First deploy: the cold-start decision

> This is the single most consequential decision at deploy time. Read this section before starting the worker for the first time.

The Soroban RPC retains approximately **24 hours** of raw event history. On a cold start (empty database), the worker begins indexing from a ledger you specify. If that ledger is older than the RPC's retention window, the RPC clamps it to the oldest ledger it still has — **events before that point are gone and cannot be recovered later**, because the RPC has discarded them and there is no other source.

### What to set

**`START_LEDGER`** — the ledger sequence number of the OurDAO contract's deployment transaction. Set this to the ledger the contract was deployed at, not `0`.

Getting it right:
- Find the contract's deployment transaction in a Stellar explorer (e.g. [Stellar Expert](https://stellar.expert) or [Stellarchain.io](https://stellarchain.io)) and note its ledger sequence number.
- Set `START_LEDGER=<that number>` before the first boot.
- Once the worker has started successfully and advanced its cursor past that ledger, `START_LEDGER` has no further effect — it is only used on an empty cursor.

**If the contract was deployed more than ~24 hours ago** and you are doing a fresh deploy now, the RPC no longer has events from the deployment ledger. The worker will start from the oldest available ledger and index forward from there. Events before that window — joins, loan requests, votes, treasury actions — will not appear in the derived tables. This is permanent.

If that history matters, the only recourse is an archive node or a Horizon-compatible event archive that retains full history. The public Soroban RPC endpoints do not.

**`START_LOOKBACK_LEDGERS`** (default: `17280`, approximately 24 hours at ~5s/ledger) — used only when `START_LEDGER` is `0`. The worker starts from `current_ledger - START_LOOKBACK_LEDGERS`. This is suitable for a deployment where the contract was also deployed very recently, or where you intentionally want to index only recent history.

### Summary

| Situation | What to set |
|---|---|
| Contract deployed recently (within ~24h) | `START_LEDGER=<contract deploy ledger>` |
| Contract deployed recently, only recent history needed | `START_LEDGER=0` and tune `START_LOOKBACK_LEDGERS` |
| Contract deployed more than ~24h ago | `START_LEDGER=<deploy ledger>` — history before the RPC window is irretrievable |

---

## Required configuration

These must be set correctly before starting either process. Wrong values here cause silent misbehaviour rather than a startup error.

### `CONTRACT_ID`

The deployed OurDAO contract id (starts with `C`). Required for the worker — it will refuse to start without it. The API will start without it but will serve empty data.

Set this to the specific contract id this deployment indexes. If `CONTRACT_ID` does not match the id stored in the database's `indexer_cursor` row, the worker refuses to start — it detects that you are pointing at a different contract and halts rather than merge two deployments' state. See [Redeploying the contract](#redeploying-the-contract).

### `DATABASE_URL`

Postgres connection string, e.g. `postgres://user:password@host:5432/dbname`. Alternatively set the individual `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` variables. Both processes read the same database.

### `CORS_ORIGIN`

**Defaults to `http://localhost:3000`.** In production, set this to the deployed frontend's origin (e.g. `https://app.ourdao.xyz`). If left at the default, the browser will block every cross-origin request from the real frontend — the API will appear to work from `curl` and fail silently in the browser.

Setting it to `*` is supported as an explicit opt-in and logs a warning at startup.

### `NETWORK_PASSPHRASE`

Defaults to the Stellar testnet passphrase. For mainnet set it to:

```
Public Global Stellar Network ; September 2015
```

### `TRUST_PROXY`

Set to `true` if the API runs behind a reverse proxy (load balancer, ingress controller, etc.). Without it, rate limiting applies per proxy IP rather than per client IP — every client shares one rate-limit bucket.

### `NONCE_STORE`

Set to `postgres` (the default) for any multi-instance API deployment. The `memory` backend is ephemeral and only suitable for local development or single-process testing — nonces are lost on restart, which allows replay attacks on the notification authentication endpoints.

---

## Full configuration reference

All configuration is environment-driven. See [`.env.example`](../.env.example) for the full annotated list. The table below notes which variables are relevant to production deployments specifically.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | API listen port. |
| `HOST` | `0.0.0.0` | API listen address. |
| `CORS_ORIGIN` | `http://localhost:3000` | **Set to the real frontend origin in production.** See above. |
| `CONTRACT_ID` | _(none)_ | **Required.** The deployed OurDAO contract id. |
| `SOROBAN_RPC_URL` | testnet | Set to your preferred RPC endpoint. Public endpoints are rate-limited. |
| `NETWORK_PASSPHRASE` | testnet | **Set to mainnet passphrase for mainnet deployments.** |
| `DATABASE_URL` | _(none)_ | Postgres connection string. |
| `NONCE_STORE` | `postgres` | Keep `postgres` for multi-instance API. |
| `START_LEDGER` | `0` | **Set to the contract's deploy ledger on first boot.** See above. |
| `START_LOOKBACK_LEDGERS` | `17280` | Used only when `START_LEDGER=0`. |
| `POLL_INTERVAL_MS` | `5000` | How often the worker polls for new events (ms). |
| `EVENTS_PAGE_LIMIT` | `100` | Events fetched per RPC call. |
| `POLL_MAX_BACKOFF_MS` | `60000` | Cap for exponential backoff after consecutive poll failures. |
| `DRAIN_MAX_PAGES` | `20` | Max pages drained per poll cycle when catching up. |
| `DRAIN_MAX_MS` | `30000` | Max wall-clock ms for one drain cycle. |
| `INDEXER_STALE_AFTER_MS` | `120000` | Cursor idle time before `/ready` reports `503`. |
| `INDEXER_QUARANTINE_AFTER_FAILURES` | `3` | Consecutive failures before an event is quarantined instead of retried. |
| `INDEXER_RESET_ON_CONTRACT_CHANGE` | `false` | Set to `true` for one boot when repointing at a new contract. **Unset after.** |
| `RATE_LIMIT_MAX` | `100` | Requests per window per IP. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms). |
| `RATE_LIMIT_EVENTS_MAX` | `30` | Stricter limit for `GET /api/events`. |
| `STATS_CACHE_MS` | `5000` | In-process cache TTL for `/api/stats`. `0` disables. |
| `TRUST_PROXY` | `false` | **Set to `true` behind a reverse proxy.** |

---

## Database connections

Both the API and the worker maintain a pool of Postgres connections. They connect to the same database but are separate OS processes with separate pools — size them together.

- **Worker**: one long-running poller with modest concurrency. The pool is used for migrations on boot, then for a rolling sequence of per-page transactions. A pool size of 2–5 is typically sufficient.
- **API**: stateless and horizontally scalable. Each instance maintains its own pool. Pool size depends on expected query concurrency; the default `pg` pool size of 10 per instance is a reasonable starting point.
- **Total connections**: `worker_pool + (api_instances × api_pool_size)` must fit within Postgres's `max_connections`. The default is 100; budget accordingly, or use a connection pooler (PgBouncer, RDS Proxy) if you scale API instances beyond a handful.

The schema is applied idempotently by both processes on boot, serialized by a Postgres advisory lock. You do not need a separate migration step. Concurrent boots (e.g. a rolling deploy of the API alongside the worker restarting) are safe.

---

## Backup and recovery

### What to back up

**The `events` table is the only irreplaceable data.** It is the append-only raw log of every on-chain event this service has indexed. Everything else — `members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`, `indexer_cursor` — is derived from it and can be reconstructed in full.

Back up `events` (and `schema_migrations`) with your normal Postgres backup strategy. The other tables do not need to be in your recovery path, though including them in a full-database backup costs nothing and speeds up recovery by skipping a reindex.

A minimal backup that enables full recovery:
```
events
schema_migrations
```

A convenient full backup restores to a working state immediately with no reindex needed:
```
pg_dump <dbname>  # all tables
```

### Recovery

If the derived tables are lost or corrupted (disk failure, accidental truncation, a bug in an event handler), they can be rebuilt from the raw log:

```bash
# Bare Node
node dist/indexer/reindex.js

# Docker
docker run --env-file .env ourdao-backend node dist/indexer/reindex.js
```

`reindex` truncates every derived table and replays the full `events` log in one database transaction. The result is byte-identical to the state produced by the incremental indexer — this is asserted by the test suite. At current scale (~100k events), a reindex completes in a few seconds. See [`docs/events-storage.md`](./events-storage.md) for growth projections and the threshold at which reindex time becomes a concern.

`reindex` is also the repair path after a detected reorg (see [Reorg detection](../README.md#reorg-detection)) and after fixing a quarantined event handler (see [Quarantine](../README.md#quarantine)).

### The `events` log is append-only

`events` rows are never mutated or deleted by normal operation. This is an architectural invariant, not just a convention — it is what makes `reindex` reliable. Do not write application code that modifies existing `events` rows. If an event was incorrectly decoded, fix the decoder and reindex; do not patch the raw row.

---

## Redeploying the contract

The OurDAO contract has no upgrade path. Every fix is a new deployment with a new `CONTRACT_ID`. Proposal and loan ids restart at 0, so pointing an existing database at a new contract would silently merge two deployments' history.

The worker detects this: it records `CONTRACT_ID` in `indexer_cursor` and refuses to start if the configured id no longer matches. You will see an error at startup.

Choose one of the following recovery paths:

### Option A: Fresh database (recommended)

Point `DATABASE_URL` at a new, empty database. The old deployment's indexed history stays queryable in the old database. Both databases share the same schema and the same API image — you can run two API instances pointing at different databases if you need to keep the old deployment accessible.

### Option B: Reuse the database

Start the worker exactly once with `INDEXER_RESET_ON_CONTRACT_CHANGE=true`. This:

1. Truncates the cursor and all derived tables (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`).
2. Keeps the raw `events` log intact (it is append-only by design). Events from the old contract remain in the log; use `?contract=<C...>` on `GET /api/events` and `GET /api/admin/log` to scope queries to one deployment.
3. Re-indexes the new contract from scratch starting at `START_LEDGER`.

After the first successful boot with the new contract, **unset `INDEXER_RESET_ON_CONTRACT_CHANGE`** (or set it back to `false`) before the next restart. Leaving it set means a worker restart will wipe derived state again.

Running one database against two contracts simultaneously is not supported — the derived tables are single-contract by construction.

---

## Operations

### Health and readiness probes

| Endpoint | Purpose | Use as |
|---|---|---|
| `GET /health` | Process alive, no DB round-trip. Returns the configured `CONTRACT_ID`. | Container health check |
| `GET /ready` | Postgres reachable + indexer cursor recently advanced. Returns `503` with a `reason` field when unhealthy. | Load-balancer readiness probe (API only) |

Configure your container health check against `/health`. Use `/ready` as the readiness probe on API instances so they are removed from the load balancer when the database is down or the indexer has fallen far behind.

Do not configure `/ready` as a health check on the **worker** — the worker has no HTTP server. The worker's health is observable only through the database (see below) or through process-level monitoring.

### Knowing the indexer is healthy

`GET /api/stats` returns two ledger values in every response:

- **`lastIndexedLedger`** — the highest ledger whose events have been folded into the derived tables. This is the number that drives the data clients see.
- **`observedTipLedger`** — the chain tip the RPC last reported. This is a freshness signal only; it is kept separate from `lastIndexedLedger` to avoid false reorg detection during catch-up.

A healthy, caught-up indexer has `lastIndexedLedger` within a few ledgers of `observedTipLedger` (Stellar closes ledgers approximately every 5 seconds; a gap of ~10–20 ledgers is normal under light load).

`GET /ready` returns `503` with `"reason": "indexer stale"` when the cursor has not advanced for longer than `INDEXER_STALE_AFTER_MS` (default 2 minutes). This is the automated staleness signal.

### What "behind" looks like and what to do

**Symptom**: `/ready` returns `503 {"reason": "indexer stale"}`, or `lastIndexedLedger` is far below `observedTipLedger`.

**Check in order:**

1. **Is the worker running?** A stopped or crashed worker is the most common cause. Check process/container status. The worker logs `[indexer] received SIGTERM` on a clean shutdown and `[indexer] fatal:` on a crash.

2. **Is the RPC reachable?** The worker logs each poll failure. Repeated failures back off exponentially up to `POLL_MAX_BACKOFF_MS` (default 60s). A burst of RPC failures is expected to self-resolve; sustained failures indicate an RPC endpoint problem.

3. **Are there quarantined events?** `GET /api/stats` reports `quarantinedEvents`. A non-zero count means the indexer encountered an event it cannot process (usually a handler bug). The worker continues indexing past quarantined events — it does not halt — but the affected derived rows may be incomplete. See `GET /api/admin/failed-events` for detail. The fix is to patch the handler and run `npm run reindex`.

4. **Did the indexer halt on a reorg?** A detected reorg causes the worker to stop immediately with a loud log line (`[indexer] reorg detected`). Confirm the chain state, then run `npm run reindex` to rebuild derived tables from the raw log. See [Reorg detection](../README.md#reorg-detection).

5. **Is the worker simply catching up?** After a restart or a long RPC outage, the worker may have pages of backlog to drain. `DRAIN_MAX_PAGES` and `DRAIN_MAX_MS` control how aggressively it catches up per poll cycle. During catch-up, `lastIndexedLedger` advances steadily — watch it over 30–60 seconds to confirm progress.

### API serving stale data

If the API is up but returning old data:

1. Check `GET /api/stats` — compare `lastIndexedLedger` and `observedTipLedger`.
2. If the indexer is caught up but data looks wrong, check `quarantinedEvents`. A handler that was quarantined left the affected derived row in the state it was in before the failing event — correct but incomplete.
3. If `/api/stats` itself looks stale, check `STATS_CACHE_MS`. The in-process cache keeps stats results for up to that many milliseconds (default 5s). With multiple API instances the cached values may briefly disagree between instances — this is expected.

### Logs

Both processes log to stdout/stderr in plain text. Structured logging is not currently implemented; forward stdout to your log aggregator.

Key log lines to monitor:

| Pattern | Meaning |
|---|---|
| `[indexer] fatal:` | Worker crashed with an unhandled error — restart and investigate. |
| `[indexer] reorg detected` | Reorg halt — manual recovery needed (see above). |
| `[indexer] quarantining event` | An event was moved to `failed_events` — handler bug, review `GET /api/admin/failed-events`. |
| `[indexer] received SIGTERM` | Clean shutdown started. |
| `[indexer] shutdown complete` | Clean shutdown finished — safe to stop the container. |
| `CORS origin is set to *` | Wildcard CORS warning — expected if intentional, worth alerting on in production. |

### Rebuilding derived state

To rebuild all derived tables from the raw event log at any time:

```bash
# The worker must not be running during a reindex.
docker run --env-file .env ourdao-backend node dist/indexer/reindex.js
```

This is safe to run at any time — it is idempotent and the result is always consistent with the raw log. It is the recovery path for reorgs, quarantined events (after fixing the handler), and any derived-table corruption. See [`docs/events-storage.md`](./events-storage.md) for expected run times at various log sizes.

---

## Related repos

This service is one of three that make up OurDAO:

| Repo | Deployment docs |
|---|---|
| [`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts) | See that repo's README for deployment ledger — you need it for `START_LEDGER`. |
| **`ourdao-backend`** (this repo) | This document. |
| [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) | Set `NEXT_PUBLIC_BACKEND_URL` to the URL of this service's API. See that repo's deployment docs for details. |

The frontend and backend deployments must agree on which contract they are talking to: `CONTRACT_ID` here and the contract id configured in `ourdao-frontend` must be the same. Mismatched contract ids produce no error — the frontend will query loan and member state from a different deployment's indexed history.

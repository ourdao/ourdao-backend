<p align="center">
  <img src="assets/logo.png" alt="OurDAO logo" width="96" />
</p>

# OurDAO Backend

[![CI](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/ourdao/ourdao-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Off-chain **indexer + read API** for the [OurDAO](https://github.com/ourdao) lending DAO on Stellar/Soroban.

The Soroban contract ([`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts)) is the single source of truth for all state, but on-chain data has [state expiration (TTL)](https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival) and keeps no queryable history — there's no way to ask the contract "list every loan proposal" or "show me this address's notification feed." This service fills that gap: it tails the contract's emitted events into Postgres and serves fast, aggregated, history-aware read APIs that [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) consumes.

It is **strictly read-only and event-driven** — it never holds keys, never signs a transaction, and cannot move funds. Every state change still happens on-chain via the user's own wallet; this service only mirrors what already happened.

This repository is one of three that make up OurDAO:

| Repo | Role |
|---|---|
| [`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts) | The Soroban contract — the single source of truth for all DAO state |
| **`ourdao-backend`** (this repo) | Off-chain indexer + read API |
| [`ourdao-frontend`](https://github.com/ourdao/ourdao-frontend) | Next.js web app members actually use |

## Table of contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Database schema](#database-schema)
- [Event catalog](#event-catalog)
- [API reference](#api-reference)
  - [Reorg detection](#reorg-detection)
  - [Quarantine](#quarantine)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

## Architecture

```
Soroban RPC ──getEvents──▶ indexer (worker.ts) ──▶ Postgres ──▶ REST API (index.ts) ──▶ frontend
                                                       │
                                                       │ LISTEN/NOTIFY (real-time)
                                                       └──────▶ SSE (/api/stream) ──▶ frontend
```

- **`src/indexer`** — a poll loop over the Soroban RPC `getEvents`, resuming from a persisted cursor (`indexer_cursor` table) rather than re-scanning from genesis on every restart. Each raw event is written to an append-only `events` log, then folded into the relevant derived table (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) inside a single database transaction, so a crash mid-poll can never leave the derived tables and the raw log inconsistent. After each successful fold, the indexer sends a Postgres NOTIFY to alert connected clients of the change. Poll failures back off exponentially (capped, configurable) instead of hammering the RPC endpoint. The `events` log is never pruned; its growth per unit of DAO activity, the secondary-index costs, and the point at which partitioning becomes worthwhile are documented in [`docs/events-storage.md`](./docs/events-storage.md) (measure with `npm run bench:events`).
- **`src/stellar/events.ts`** — the event catalog: the exact topic-symbol → data-tuple mapping the contract publishes, decoded via `scValToNative` and converted to JSON-safe primitives (bigints become strings, since JSON has no native 128-bit integer type).
- **`src/api`** — a [Fastify](https://fastify.dev) server exposing the read endpoints in the [API reference](#api-reference) below. Includes both request/response REST routes and a Server-Sent Events (SSE) stream at `/api/stream` for real-time notifications.
- **`src/db`** — the Postgres schema (applied idempotently on boot by both the API and worker processes) and a thin query helper over [`pg`](https://node-postgres.com/).
- **Real-time notifications** — the indexer and API processes communicate through Postgres LISTEN/NOTIFY. After each fold transaction commits, a NOTIFY fires, which the API's shared listener receives and fans out to connected SSE clients. This message-passing topology is documented in detail in [`docs/REALTIME-NOTIFICATIONS.md`](./docs/REALTIME-NOTIFICATIONS.md), including delivery guarantees, connection costs, and PgBouncer incompatibility.

The API process and the indexer worker are separate entrypoints (`index.ts` / `worker.ts`) so they can be scaled or deployed independently — e.g. one long-running indexer worker behind several stateless, horizontally-scaled API instances.

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres (or point DATABASE_URL at your own instance)
docker compose up -d

# 3. Configure
cp .env.example .env
#   set CONTRACT_ID to your deployed OurDAO contract id (starts with C)

# 4. Run the API (http://localhost:4000)
npm run dev

# 5. In another terminal, run the indexer
npm run dev:worker
```

Production build:

```bash
npm run build
npm start              # API
npm run start:worker   # indexer
```

## Deployment

The full deployment guide is in **[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)**. Key points that are easy to get wrong:

- **The worker must run as a singleton.** Running two workers concurrently corrupts vote tallies through non-idempotent increments — the failure is silent. The API is stateless and can scale horizontally; the worker cannot.
- **Set `START_LEDGER` before the first boot.** The public Soroban RPC retains roughly 24 hours of event history. If your contract was deployed before that window, set `START_LEDGER` to the contract's deploy ledger. Events older than the RPC window are permanently unavailable — you cannot fetch them later.
- **Set `CORS_ORIGIN` to the real frontend origin.** It defaults to `http://localhost:3000`. Leaving it at the default silently blocks every browser request from the production frontend.
- **`events` is the only table you must back up.** All other tables (`members`, `loan_proposals`, `loans`, etc.) are derived from it and can be rebuilt with `npm run reindex`.
- **Repointing at a new `CONTRACT_ID` requires an explicit reset step.** The worker refuses to start if the configured contract id doesn't match the one stored in the cursor — see [Redeploying the contract](./docs/DEPLOYMENT.md#redeploying-the-contract) for options.

## Configuration

All configuration is environment-driven — see [`.env.example`](./.env.example) for the full annotated list. Key values:

| Variable | Purpose |
|---|---|
| `CONTRACT_ID` | Deployed OurDAO contract id. **Required** for the indexer to run. |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (defaults to public testnet). |
| `NETWORK_PASSPHRASE` | Testnet by default; switch for mainnet. |
| `STELLAR_LEDGER_CLOSE_TIME_SECONDS` | Nominal Stellar ledger close time in seconds, used by `/ready` to turn `ledgersBehind` into `estimatedLagSeconds` (default 5; not an SLA). |
| `DATABASE_URL` | Postgres connection string (or set the individual `PG*` vars). |
| `DB_POOL_MAX` | Max size of the shared request pool (default 10, node-postgres's own default made explicit — issue #152). `/api/stream` no longer takes a connection per client (see the `/api/stream` row below), so this only has to cover ordinary request concurrency. |
| `DB_CONNECTION_TIMEOUT_MS` | How long (ms) a caller waits for a free pool connection before pg gives up (default 5000). Without this the pool waits forever when exhausted or when Postgres is unreachable at the TCP level (issue #167). |
| `DB_STATEMENT_TIMEOUT_MS` | Postgres `statement_timeout` (ms) applied to every connection this pool opens (default 10000). Kills a query that hangs after the connection succeeded — a stuck lock, a database mid-failover — instead of leaving it to run indefinitely (issue #167). |
| `READY_CHECK_TIMEOUT_MS` | How long (ms) `/ready`'s Postgres check is allowed to run before it's treated as a timeout rather than waiting on `DB_CONNECTION_TIMEOUT_MS`/`DB_STATEMENT_TIMEOUT_MS` to fire on their own (default 3000). Distinguishes a hung database (`postgres_timeout`) from a refused connection (`postgres_unreachable`) in the response body (issue #167). |
| `START_LEDGER` / `START_LOOKBACK_LEDGERS` | Where to start indexing on a cold start. Public Soroban RPC only retains ~24h of events, so an old start ledger gets clamped to the oldest the RPC still serves. |
| `POLL_INTERVAL_MS` / `EVENTS_PAGE_LIMIT` | Indexer poll cadence and page size. |
| `POLL_MAX_BACKOFF_MS` | Cap for exponential backoff after consecutive poll failures (default 60s). |
| `DRAIN_MAX_PAGES` | Max pages per poll drain cycle when catching up (default 20). |
| `DRAIN_MAX_MS` | Max wall-clock ms for a single drain cycle (default 30s). |
| `INDEXER_STALE_AFTER_MS` | How long (ms) the cursor can be idle before `/ready` reports stale (default 120s). |
| `INDEXER_QUARANTINE_AFTER_FAILURES` | After this many consecutive whole-page failures with the same error on the same page, the poller quarantines the offending event(s) instead of retrying forever (default 3). See [Quarantine](#quarantine). |
| `INDEXER_RESET_ON_CONTRACT_CHANGE` | `true` for one boot to wipe the cursor + derived tables when `CONTRACT_ID` changes (redeploy). Default `false` — a mismatch refuses to start. See [Redeploying the contract](#redeploying-the-contract). |
| `CORS_ORIGIN` | Comma-separated allowed origins for the API (the frontend's URL). Defaults to `http://localhost:3000`. Set to `*` to allow all origins (a warning is logged at startup). |
| `RATE_LIMIT_MAX` | Global rate limit: max requests per window per IP (default 100). |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds (default 60000). |
| `RATE_LIMIT_EVENTS_MAX` | Stricter rate limit for `GET /api/events` (default 30). |
| `STATS_CACHE_MS` | How long (ms) an `/api/stats` result is cached in-process before it is recomputed (default 5000; `0` disables). Reported figures are at most this stale. |
| `REDIS_URL` | Optional Redis connection URL for the one-hour shared cache on `/api/stats/history`; without it, the endpoint uses an in-process cache. |
| `STREAM_MAX_CONNECTIONS` | Max concurrent `/api/stream` SSE connections per process (default 100). Excess connections get `503` + `Retry-After` (issue #156). |
| `STREAM_MAX_CONNECTIONS_PER_IP` | Max concurrent stream connections per client IP (default 10). |
| `STREAM_IDLE_TIMEOUT_MS` | Socket idle timeout for stream connections in ms (default 60000). Heartbeats keep healthy clients alive. |
| `STREAM_RETRY_AFTER_SECONDS` | `Retry-After` value (seconds) on stream-cap `503` responses (default 30). |
| `TRUST_PROXY` | Set to `"true"` behind a reverse proxy so rate limits apply per client IP. |
| `LOG_LEVEL` | Pino log level for the Fastify server (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). Default `info` (logs a line per request). `silent` suppresses all request logging, which the test harness uses. |
| `TEST_DATABASE_URL` | Separate database `npm test` runs against — never the dev DB. |
| `SOURCE_COMMIT` / `BUILD_DATE` | Build metadata exposed by `/version`; normally injected by the Docker build. |
| `RUN_RPC_SMOKE` | Set to `true` to opt into the live Soroban RPC smoke test. |

The nonce TTL, in-memory capacity, and cleanup cadence are fixed in
`src/auth.ts`; they are documented in `.env.example` but are not operator
settings. The stream heartbeat interval and channel set are likewise fixed in
`src/api/stream.ts`. `NODE_ENV` and `VITEST` are owned by the runtime and test
runner rather than read as application configuration.

**Note:** The indexer (worker process) uses `console.log`/`console.error` directly and does not respect `LOG_LEVEL`. Its output is always shown regardless of this setting.

## Database schema

Postgres, applied by `src/db/migrate.ts` on every boot — both the API and the worker call it at startup, so it's safe with no separate migration-runner step to remember to run.

`src/db/schema.sql` is the bootstrap baseline: idempotent `CREATE TABLE/INDEX IF NOT EXISTS` statements describing the *current* desired shape. That's sufficient for a brand-new database, but `IF NOT EXISTS` silently no-ops on a table that already exists — including when a column was added or a type changed. Those changes instead live as numbered files in `src/db/migrations/` (e.g. `0001_widen_vote_columns.sql`), applied in order and tracked in a `schema_migrations` table so each one runs exactly once per database. A fresh database created from `schema.sql` already has every migration's end state, so its migrations are recorded as applied without re-running their SQL; an existing database gets the real `ALTER` statements. A Postgres advisory lock serializes `migrate()` across the API and worker so they don't race to apply the same migration concurrently on startup.

To add a schema change: update `schema.sql` to the new desired shape (for fresh databases) *and* add a new numbered file under `src/db/migrations/` with the `ALTER`/`CREATE`/etc. needed to get an existing database there (for everyone else).

| Table | Purpose | Notable columns |
|---|---|---|
| `schema_migrations` | Tracks which numbered migrations have been applied | `version`, `name`, `applied_at` |
| `indexer_cursor` | Single-row resume state for the poll loop | `paging_token`, `last_ledger` (highest ledger actually folded), `observed_tip_ledger` (RPC-observed chain tip — freshness only, kept separate from `last_ledger` since issue #45), `contract_id` (cursor is discarded on a cold start if it belongs to a different contract) |
| `events` | Append-only raw event log — the source everything else is derived from | `symbol`, `topics` (JSONB), `data` (JSONB), `tx_hash` |
| `members` | Current membership state | `contribution`, `stake`, `has_active_loan`, `pending_claimed`, `name` (from the registry), `defaults_count` |
| `loan_proposals` | Loan votes in flight | `status` (`pending`/`approved`/`rejected`), `votes_for`, `votes_against`, `voter_count` |
| `loans` | Disbursed loans | `status` (`active`/`repaid`/`defaulted`), `total_repayment`, `outstanding`, `due_time`. **`id` doubles as the originating `loan_proposals.id`** — the contract reuses the proposal's own id for the disbursed loan rather than a separate counter, since a proposal produces at most one loan. |
| `treasury_proposals` | Treasury withdrawal votes | `private` (routed through commit-reveal instead of open voting), `status`, `votes_for`, `votes_against`, `voter_count` |
| `notifications` | Per-address notification feed | `type`, `read`, indexed on `(address, read)` |
| `documents` | Existence/history of a proposal's attached documents (issue #44) — one row per `doc_attn` event, never the content hash itself | `proposal_id`, `kind` (`loan`/`treasury` — loan and treasury proposal ids collide, drawn from independent sequences), `caller`, `ledger` |
| `failed_events` | Quarantine record for a handler that failed deterministically (issue #43) — additive, never mutates the `events` row it came from | `event_id`, `symbol`, `ledger`, `error`, `resolved_at` (issue #168 — set once a reindex or replay re-folds the event, never deleted) |

On-chain `i128` amounts are stored as `NUMERIC(40,0)` (an i128's max value is ~1.7×10³⁸, which fits under 10³⁹) and returned from the API as **decimal strings**, never JSON numbers, to avoid silent precision loss — this was in fact a real bug found and fixed during development: `pg` returns Postgres `BIGINT` columns as JS strings by default, and the original code assumed they came back as numbers.

**Column-type rule for amounts vs. sequences.** On-chain `i128` amounts are `NUMERIC(40,0)` and cross the API boundary as strings. Ledger sequence numbers are `BIGINT` and are returned as JSON numbers — `src/db/index.ts` registers a `BIGINT → number` parser **scoped to this repo's connection pool**, not on the process-wide `pg.types` registry (a global parser silently truncated any `BIGINT` above 2⁵³, for every pg consumer in the process). Nothing else should be `BIGINT`: a token amount stored as `BIGINT` would be parsed to a `number` by that pool parser and lose precision above 2⁵³ with no error. Use `NUMERIC(40,0)` for any new amount column, and only `BIGINT` for a genuine ledger/sequence value.

**Vote tallies are stake-weighted, not a headcount.** The contract grants each voter `1 + min(stake / STAKE_WEIGHT_UNIT, MAX_STAKE_BONUS)` voting power (currently up to 6) and sums that into `for_votes`/`against_votes`. `votes_for`/`votes_against` mirror that (hence `NUMERIC(40,0)`, matching the contract's own field width, not a plain vote count); `voter_count` is the distinct-voter headcount alongside it, so a client can show both "7 members voted" and "carrying 19 voting power." **The contract doesn't publish the weight it applied yet** — `loan_vote`/`tre_vote`/`revealed` currently carry only `support` — so today every vote folds in as weight 1 regardless of stake, and `votes_for`/`votes_against` under-count for any staked voter until [the upstream fix](https://github.com/ourdao/ourdao-contracts) lands. The API explicitly surfaces a `tallies_weighted: false` flag on proposals until this is resolved. The decoder and handlers already read a `weight` field the moment the contract adds one, with no further backend change needed.

**A loan's `outstanding` balance starts at `total_repayment`, not the principal.** The contract collects `total_repayment = amount + interest` on `repay_loan`, so a loan is never worth just its principal from a borrower's perspective. `loan_appr` doesn't publish `total_repayment` (only the disbursed `amount`), so the indexer sources it from the just-approved `loan_proposals` row instead — `loans.id == loan_proposals.id` is a documented contract invariant, and that row already carries `total_repayment` from `loan_req`/`loan_edit`. This depends on that proposal row existing, which it will unless the indexer started mid-history; if it's missing, `total_repayment` falls back to the principal. `due_time` has the same gap — the contract computes it but doesn't publish it on `loan_appr` — so it's `NULL` until that's fixed upstream. `GET /api/loans` and `/api/loans/:id` also expose `interest_charge` and `repaid_amount`, both derived from `total_repayment` at read time (`null` for a loan whose amount columns are malformed — see `src/api/loan-derived.ts`; the rest of the list is unaffected).

**Required fields are validated, not coerced (issue #42).** Every handler in `src/indexer/handlers.ts` reads its decoded fields through either the `require*` helpers (`requireAddr`/`requireId`/`requireAmount`/`requireBool`/`requireProposalKind`) or the older `str`/`num`/`addr` coercion helpers. The `require*` helpers are for a field a derived row depends on — a missing or malformed one throws instead of silently coercing into a plausible-looking default (a missing amount becoming `'0'`, a bad id becoming `NULL` and matching zero rows, a non-string address becoming `''`). `str`/`num`/`addr` are kept only for genuinely optional fields with no on-chain equivalent yet (`weight`, `due_time`) or that no stored row depends on. A thrown `FieldValidationError` rolls back the write and is handled the same way any other deterministic handler error is — see [Quarantine](#quarantine).

### Redeploying the contract

The OurDAO contract has **no upgrade path** — every fix is a fresh deployment with a new `CONTRACT_ID`. Proposal and loan ids restart at 0 for a new deployment, and `loans.id` / `loan_proposals.id` are primary keys, so pointing an existing database at a new contract would silently merge two deployments' state (the new contract's proposal 0 overwriting the old one's under `ON CONFLICT (id) DO UPDATE`, members' contributions blending, and so on).

The indexer records which contract its cursor belongs to (`indexer_cursor.contract_id`). When `CONTRACT_ID` no longer matches, it **refuses to start** rather than resume. To repoint at a new deployment, choose one:

- **Fresh database (recommended):** point `DATABASE_URL` at a new, empty database. The old deployment's indexed history stays queryable where it is.
- **Reuse the database:** start the worker once with `INDEXER_RESET_ON_CONTRACT_CHANGE=true`. This truncates the cursor and every derived table (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`) and re-indexes the new contract from scratch. The append-only `events` log is **kept** — pass `?contract=<C...>` to `GET /api/events` and `GET /api/admin/log` to scope the raw log to one deployment. Unset the flag again after the first successful boot.

Running one database against multiple contracts simultaneously is deliberately not supported — the derived tables are single-contract by construction.

## Event catalog

The full topic-symbol → data-tuple mapping this service decodes (kept in sync with `ourdao-contracts`'s `env.events().publish(...)` calls):

| Symbol | Fields | Derived-table effect |
|---|---|---|
| `joined` | `member, fee` | upserts `members`, notifies the member |
| `exited` | `member, share` | marks the member exited |
| `claimed` | `member, pending` | tracks claimed yield |
| `loan_req` | `id, borrower, amount, total_repayment` | inserts a pending `loan_proposals` row |
| `loan_edit` | `proposal_id, borrower, new_amount, total_repayment` | updates the proposal |
| `loan_vote` | `proposal_id, voter, support`, plus a reserved `weight` not yet published (see above) | adds the vote's weight to the tally, bumps `voter_count` |
| `loan_wait` | `id, amount` | the proposal reached quorum but the treasury can't cover it yet — marks it `approved_pending_disbursement` (issue #125). A later `disburse_approved_loan` call resolves this and republishes `loan_appr` |
| `loan_rej` | `id, for_votes, against_votes` | an early rejection when the votes still outstanding can no longer reach quorum (issue #124) — marks the proposal `rejected`, distinct from `loan_exp`'s post-window keeper path below |
| `loan_appr` | `id, borrower, amount`, plus a reserved `due_time` not yet published | marks the proposal approved, opens a `loans` row seeded with `total_repayment` from the matching proposal (not the bare principal — see below), flags the borrower's `has_active_loan` |
| `loan_rpy` | `loan_id, borrower, outstanding` | updates outstanding balance; marks `repaid` when it hits zero |
| `loan_dflt` | `loan_id, borrower, penalty` | marks the loan `defaulted`, slashes the borrower's `contribution` by the penalty (clamped at zero), bumps `defaults_count`, clears `has_active_loan` — idempotent, so redelivering the same event is a no-op past the first application |
| `interest` | `interest, active` | no per-member breakdown to attribute, but folded into `dao_totals.interest_collected` and one `interest_distributions` row (issue #24). `interest` is interest *collected* — the contract keeps the indivisible per-member remainder, so it slightly exceeds what members were credited. Per-member yield is still surfaced via `claimed`. |
| `tre_prop` | `id, amount, destination, private` | inserts a pending `treasury_proposals` row |
| `tre_vote` | `id, voter, support`, plus a reserved `weight` not yet published | adds the vote's weight to the tally, bumps `voter_count` |
| `tre_wait` | `id, amount` | treasury equivalent of `loan_wait` above (issue #125) — marks the proposal `approved_pending_disbursement` |
| `tre_rej` | `id, for_votes, against_votes` | treasury equivalent of `loan_rej` above (issue #124) — marks the proposal `rejected` |
| `tre_exec` | `id, amount, destination` | marks the proposal executed, notifies the recipient |
| `staked` / `unstaked` | `member, amount, new_stake` | updates the member's stake |
| `name_reg` | `name, owner` | updates the member's registered name |
| `committed` | `proposal_id, voter` | notifies the voter their commit was recorded |
| `revealed` | `proposal_id, voter, support`, plus a reserved `weight` not yet published | tallies the same as an open vote |
| `doc_attn` | `kind, proposal_id, caller` | inserts a `documents` history row (issue #44) — existence/history only; the content hash itself is still read live from the contract via `get_document`, never indexed |
| `init`, `admin_add`, `admin_rem`, `threshold`, `policy`, `paused`, `unpaused` | varies | admin/governance events — surfaced via `/api/admin/log`, not folded into a derived table |

## API reference

The unversioned `/api` contract is additive-only. See the
[API compatibility policy](./docs/API_COMPATIBILITY.md) for the concrete
definition of a breaking change, the versioning and deprecation process, and
the required coordination with `ourdao-frontend`.
**Machine-readable OpenAPI specification:** [`openapi.json`](./openapi.json)

Interactive documentation is available at `/docs` when running the development server (`npm run dev`).

### Quick reference

Base path: `/api`.

**Core endpoints:**
- `GET /health` — Liveness check + currently configured contract id (no DB round trip)
- `GET /ready` — Readiness probe (checks Postgres reachability and indexer freshness; a recorded ledger discontinuity answers `503` with `reason: reorg_detected`, see [Reorg detection](#reorg-detection))
- `GET /version` — Build metadata (version, commit, build date)
- `GET /api/stats` — Aggregate DAO statistics (members, loans, proposals, money figures, quarantine count, indexer state, and `reorgDetected`/`reorgHalt` for an uncleared ledger discontinuity)
- `GET /api/stats/history` — Daily loan principal lent/repaid, defaults, defaulted value, and cumulative default rate (`data` timeseries; money values are decimal strings)

**Members:**
- `GET /api/members` — Active members list
- `GET /api/members/:address` — Single member details
- `GET /api/members/:address/summary` — Member dashboard (member row, loans, notifications, relative position)
- `GET /api/members/:address/activity` — Member's cross-entity activity feed (`?symbol=` narrows it to one of the member-activity event kinds; an out-of-set symbol is a `400`; plus `?before=<ledger>` and `?limit=`)

**Loans:**
- `GET /api/proposals/loan` — Loan proposals with vote tallies
- `GET /api/loans` — Loans list (optional `?borrower=` filter)
- `GET /api/loans/:id` — Single loan
- `GET /api/loans/:id/timeline` — Loan's full lifecycle events

**Treasury:**
- `GET /api/proposals/treasury` — Treasury proposals with vote tallies
- `GET /api/proposals/treasury/:id/timeline` — Treasury proposal's full lifecycle events

**Notifications:**
- `GET /api/notifications?address=` — Notifications for an address
- `PATCH /api/notifications/:id/read` — Mark one notification read (authenticated)
- `PATCH /api/notifications/read-all?address=` — Mark all notifications read (authenticated)

**Events & History:**
- `GET /api/events` — Raw event feed (optional filters: `?symbol=`, `?contract=`, `?before=`, `?after=`, `?order=`)
- `GET /api/interest` — Interest distribution history
- `GET /api/documents` — Document attachment history, newest ledger first. All filters optional and combinable: `?kind=loan|treasury`, `?proposal_id=` (requires `kind` — loan and treasury ids collide), `?caller=<G… address>` (a member's attachments), plus `?before=<ledger>` and `?limit=`

**Admin:**
- `GET /api/admin/log` — Admin/governance audit trail
- `GET /api/admin/failed-events` — Quarantined events, newest first: `?before=<id>` cursor, `?unresolved=true`, `?symbol=`, `?from_ledger=`/`?to_ledger=` (inclusive, at most 10000 ledgers apart), `?limit=`; `X-Total-Count` carries the size of the filtered set so the scale is visible without paging

**Real-time:**
- `GET /api/stream` — Server-Sent Events stream for real-time change notifications

**Authentication:**
- `GET /api/auth/challenge` — Request a nonce for signature-based authentication

For detailed request/response schemas, query parameters, and authentication requirements, see the [OpenAPI specification](./openapi.json) or visit `/docs` on a running instance.

**Frontend integration:** The OpenAPI spec can be used to generate type-safe client code for `ourdao-frontend`. Tools like [openapi-typescript](https://github.com/drwpow/openapi-typescript) or [openapi-generator](https://github.com/OpenAPITools/openapi-generator) can consume `openapi.json` directly to generate TypeScript types matching the API's actual response shapes, eliminating manual transcription of types from `src/types.ts`.

### Common patterns

All list endpoints accept `?limit=` (default 50, max 200). `?before=` and `?after=` are cursors: pass the `id` (or `ledger`) of the last row you saw to page. For `/api/events`, the cursor can be a deterministic `(ledger, id)` value and ordering is strictly deterministic (`ledger DESC, id DESC` by default, or `ASC`). 

On-chain `i128` amounts are returned as decimal **strings** to preserve precision (see [Database schema](#database-schema)); ledger sequence numbers are returned as regular JSON numbers.

### Reconnecting and missed changes

Every SSE frame on `/api/stream` carries an `id:` field. It is the highest ledger sequence number this connection has been shown a change for — not `Date.now()` — so it is both monotonic (per connection) and meaningful (it corresponds to a real point in the indexed chain, and only advances, never repeats a lower value). Heartbeats and the initial "Connected to stream" message report the same id, not a fresh one, since they carry no change of their own.

Browsers implementing `EventSource` remember the last `id:` they saw and resend it automatically as a `Last-Event-ID` header when they reconnect (after a sleeping laptop, a proxy timeout, a rolling deploy, …). The server reads that header and, if it knows a current ledger, immediately sends a `resync` event before anything else:

```json
{ "type": "resync", "payload": { "missed": true, "lastKnownLedger": 512034 } }
```

`missed: true` means at least one change happened while this client was away; `missed: false` means it reconnected caught up. A fresh connection with no `Last-Event-ID` gets no `resync` event at all — there's nothing to compare against.

**This is a "you may be behind, go refetch" signal, not event replay.** The server does not buffer or replay the individual changes that happened while disconnected — deliberately: every message on this stream is already just a lightweight "X changed, go refetch" pointer rather than a full payload (see the endpoint table above), so replaying old signals wouldn't tell a client anything more precise than "something changed, refetch it" — which `resync: { missed: true }` already says, without a durable buffer to build and bound. A client that needs precise historical detail should page `/api/events` instead, which is the actual source of truth and already supports cursor-based pagination.

**Clients should keep their polling fallback.** Because there is no replay, a client that was disconnected long enough to miss changes still needs to refetch from the REST endpoints — the stream tells you *that* you're behind, not *what* changed. `ourdao-frontend`'s existing 15s `/api/stats` poll (or equivalent per-resource refetches) remains the correct way to recover, with the stream layered on top purely to make the common case (already caught up, or only briefly behind) near-instant instead of waiting for the next poll tick.

### Errors

Every error response — a deliberate `4xx` from a route, a failed request body, a rate-limited request, or anything thrown while handling the request — carries at least these fields:

```json
{ "error": "loan not found", "code": "NOT_FOUND", "correlationId": "b1f2c3d4-..." }
```

- **`code`** is a stable, machine-readable cause from the table below. **Branch on `code`, never on `error`** — the text may be reworded at any time.
- **`error`** is a short, safe, human-readable string. It never contains a stack trace, SQL, or raw database driver text. Deliberate `4xx` messages (`invalid loan id`, `address query param is required`, …) are passed through unchanged; every `5xx` is a generic string (`internal server error`) with the real cause written only to the server log.
- **`correlationId`** is the request id. It is also returned in the `x-correlation-id` response header (on success and failure alike) and printed as `reqId` on the matching server-side log line, so a user-reported failure can be traced to its log entry.

Postgres failures are mapped to a sensible status rather than an opaque `500`, and the driver's message (which would name columns, constraints and types) is logged, never returned.

| `code` | Status | Meaning |
|---|---|---|
| `BAD_REQUEST` | `400` | A route rejected the request's parameters (bad id, cursor, limit, address, …). |
| `VALIDATION_FAILED` | `400` | The request failed schema validation; `error` names the offending field. |
| `UNAUTHORIZED` | `401` | Authentication is missing or invalid. |
| `FORBIDDEN` | `403` | Authenticated, but not allowed to act on this resource. |
| `NOT_FOUND` | `404` | The route exists but the requested entity does not. |
| `ROUTE_NOT_FOUND` | `404` | No such route. |
| `REQUEST_TIMEOUT` | `408` | The client did not send a complete request in time (`HTTP_REQUEST_TIMEOUT_MS`). |
| `PAYLOAD_TOO_LARGE` | `413` | The request body exceeds `HTTP_BODY_LIMIT_BYTES`. |
| `RATE_LIMITED` | `429` | Rate limit exceeded; honour `Retry-After`. |
| `CLIENT_ERROR` | other `4xx` | Any other client error. |
| `RESOURCE_ALREADY_EXISTS` | `409` | Postgres unique violation. |
| `RELATED_DATA_CONFLICT` | `409` | Postgres foreign-key violation. |
| `CONSTRAINT_VIOLATION` | `422` | Postgres check violation. |
| `MISSING_REQUIRED_VALUE` | `422` | Postgres not-null violation. |
| `DATABASE_UNAVAILABLE` | `503` | The database is unreachable or shutting down; safe to retry. |
| `SERVICE_UNAVAILABLE` | `503` | The server shed the request (e.g. `/stats` or `/stream` at capacity); retry after `Retry-After`. |
| `INTERNAL_ERROR` | `5xx` | Anything else. |

Codes are **append-only** (`ERROR_CODES` in [`src/api/errors.ts`](src/api/errors.ts)): a code is never renamed, removed or repurposed, only added. Unknown codes should be treated by clients like the generic code for their status.

> `/ready`'s `503` is a probe status (`{ status, reason, … }`), not an error, and keeps that shape.

> `429` responses from the rate limiter (`@fastify/rate-limit`) keep that plugin's own fields (`statusCode`, `error`, `message`) and additionally carry `code` and `correlationId`.

### Caching

Every response's `Cache-Control` comes from one of four **named policies** defined in [`src/api/cache-policy.ts`](src/api/cache-policy.ts). Routes select a policy by name (`setCachePolicy(reply, 'public-live')`); nothing writes a raw directive, and `test/cache-policy.test.ts` fails on an ad-hoc `Cache-Control` literal or a route that answers with a value outside the set.

| Policy | Header | Applies to |
|---|---|---|
| `public-live` | `public, max-age=5, must-revalidate` | Tip-of-chain reads: `/members`, `/members/:address`, `/members/:address/activity`, `/proposals/*`, `/loans`, `/loans/:id`, the two `/timeline` routes, `/stats`, `/stats/history`, and `/events`, `/admin/log`, `/interest`, `/documents` **without** a cursor. |
| `public-historical` | `public, max-age=3600, must-revalidate` | Cursor pages, which are append-only behind the cursor: `/events` (`?before=`/`?after=`), `/admin/log?before=`, `/interest?before=`, `/documents?before=`. |
| `private` | `private, no-cache` | Member-specific data: `/members/:address/summary`, `/notifications`. Never `public`. |
| `no-store` | `no-store` | Authentication challenges, `PATCH` mutations, `/health`, `/ready`, `/version`, `/admin/failed-events`, and the `/stream` SSE endpoint. |

- **Default:** a route that names no policy gets `no-store` (an `onRequest` hook), so omitting a decision can never make a response cacheable. An unknown directive is replaced with `no-store` and logged.
- **Authenticated responses are never shared-cacheable:** a request carrying an `Authorization` header is downgraded from any `public-*` policy to `private`.
- **ETag and revalidation:** `@fastify/etag` is registered globally. Every `public-*` and `private` response relies on it — after `max-age` (or immediately, for `private`) the client sends `If-None-Match` and gets `304` when nothing changed. `no-store` responses carry no `ETag`, since nothing may be stored to revalidate.
- **Lifetimes are bounded (issue #190):** no policy exceeds one hour and none is `immutable`. Cursor pages used to be cached for a year and never revalidated, which meant a wrong response (a filtering bug, a shape change) stayed pinned in every intermediary and browser with no way to invalidate it, because no URL carries a version. One hour is the longest an incident can be waited out; `immutable` is reserved for a future versioned path. `test/cache-policy.test.ts` enforces both bounds.
- **Per endpoint:**

  | Endpoint | Policy |
  |---|---|
  | `/health`, `/ready`, `/version`, `/metrics`, `/health/dependencies` | `no-store` |
  | `/api/auth/*`, `PATCH /api/notifications/*`, `/api/admin/failed-events`, `/api/admin/failed-events/*`, `/api/admin/audit-log`, `/api/stream` | `no-store` |
  | `/api/members/:address/summary`, `/api/notifications` | `private` |
  | `/api/members`, `/api/members/:address`, `/api/members/:address/activity`, `/api/proposals/*`, `/api/loans`, `/api/loans/:id`, `/api/loans/:id/timeline`, `/api/proposals/treasury/:id/timeline`, `/api/stats`, `/api/stats/history` | `public-live` |
  | `/api/events`, `/api/admin/log`, `/api/interest`, `/api/documents` without a cursor | `public-live` |
  | `/api/events`, `/api/admin/log`, `/api/interest`, `/api/documents` with `?before=` (or `?after=`) | `public-historical` |

  `/api/documents` is public data (which proposals carry attachments, from on-chain events); the `?caller=` filter selects by a public address and adds nothing member-specific, so its pages stay `public`.

### Reorg detection

> **On-call? Start here:** [`docs/REORG_RECOVERY.md`](./docs/REORG_RECOVERY.md) is the full runbook — how each check below works, diagnostic SQL for the cursor, triage, and the step-by-step recovery procedure.

Stellar's consensus gives fast finality, so a deep reorg is genuinely unlikely — but the indexer now *notices* one rather than silently folding events from a diverged history (issue #23):

- The cursor stores `last_ledger` and `last_ledger_hash` — the hash of that same ledger, fetched by sequence from the RPC (Soroban's `getEvents` exposes no per-event ledger hash, so this is the only way to get one).
- Each poll checks continuity two ways: if the RPC's reported latest ledger is **below** the last folded ledger, or a fetched page contains an event from a ledger already folded past, the indexer **halts** with a loud log line instead of retrying. It also re-fetches the RPC's current hash for `last_ledger` and compares it against what's stored (issue #128) — this catches a **same-height fork**, where history diverges without the ledger sequence ever moving backwards, which the sequence-only checks can't see. A ledger the RPC has since pruned is treated as unverifiable, not as a fork.
- **The halt is recorded, not only logged (issue #191):** before the worker exits it writes the discontinuity (contract, last folded ledger and hash, detail) to `reorg_halts`. While that record is uncleared, `GET /ready` answers `503` with `reason: reorg_detected` (a different reason from `indexer_stale`, so an orchestrator can tell a deliberate halt from a slow RPC), `GET /api/stats` reports `reorgDetected: true` with the details in `reorgHalt`, and **the worker refuses to start** — an automatic container restart cannot resume past diverged history. `npm run reindex` clears the record in the same transaction as the rebuild; `npm run reorg:clear` acknowledges a false alarm without rebuilding.
- **Recovery:** stop the indexer worker (`node dist/worker.js`) and run `npm run reindex` (`node dist/indexer/reindex.js` in the container). It truncates the derived tables and rebuilds them from the raw `events` log in one transaction — the log is authoritative and untouched. A rebuild produces state identical to the incremental fold (asserted by a test), so `reindex` is also the repair path for the historical-data bugs tracked in other issues. The complete diagnosis-and-recovery procedure is the runbook: [`docs/REORG_RECOVERY.md`](./docs/REORG_RECOVERY.md).
- **Worker serialization (Advisory Lock):** Both `reindex` and the worker's event fold loops acquire a dedicated session-level Postgres advisory lock (`0x0d400001`). If a reindex is attempted while a worker is running or folding, it fails immediately with an actionable error rather than racing to corrupt derived state.
- **Streaming & Memory Bounds:** The rebuild streams the event log via keyset pagination over `(ledger, id)` in batches (default 1,000) inside a single transaction, keeping Node.js memory flat (~40–60 MB RSS) regardless of event log size (e.g., 100k+ events). Progress is logged periodically with event counts, percentage, throughput (events/s), and estimated ETA.
- **Rebuild Performance Expectations:**
  - **10k events:** ~1–2 seconds, ~45 MB peak RSS.
  - **100k events:** ~10–20 seconds, ~55 MB peak RSS.
  - **500k events:** ~50–90 seconds, ~60 MB peak RSS.
- **Unrecoverable:** events that were orphaned *and* already pruned from the RPC's ~24h window can't be re-fetched; `reindex` rebuilds from whatever the raw log holds.
- **`last_ledger` only ever advances to a ledger whose events were actually folded (issue #45).** An earlier version fell back to the RPC's reported chain tip on an empty `getEvents` page, which conflated "highest ledger folded" with "how current the RPC is" — during catch-up, one empty page could jump `last_ledger` to the tip, and the very next real (but still historically-earlier) page would then look like a rewind and trigger a false halt. The RPC-observed tip is tracked in its own column, `observed_tip_ledger` — freshness reporting only (`/ready`, `/api/stats.observedTipLedger`), never fed into the continuity check above.

### Quarantine

A handler bug used to be able to wedge the indexer permanently: `ingestPage` folds a whole page in one transaction, so one event whose handler throws rolled back the entire page, and the poll loop retried the *same* page forever behind exponential backoff (capped at `POLL_MAX_BACKOFF_MS`) — the process stayed up and kept logging the same error, but indexed nothing (issue #43).

- The poller can't tell a transient failure (RPC hiccup, a DB restart — expected to clear on retry) from a deterministic one (a handler bug, a value that overflows its column) from the error alone. It infers it from repetition: if the *same* page fails with the *same* error `INDEXER_QUARANTINE_AFTER_FAILURES` times in a row (default 3), that's not transient.
- Once that threshold is hit, the page is retried **one event per transaction** instead of the whole page at once. Each event's raw log row is written (and stays written) regardless of whether folding it succeeds; if folding throws, that one transaction rolls back and the event is recorded in `failed_events` (id, symbol, ledger, error) instead — every other event in the page still folds normally, and the cursor advances past all of them.
- On this per-event path, the raw log write and the fold necessarily commit as two separate transactions (the raw write has to survive a fold that then fails). `events.folded_at` tracks fold completion independently of the row's own existence (issue #119), so a crash between the two — the raw row committed, the fold didn't — is retried on the next pass instead of being mistaken for an already-handled event. A failure recording an event to `failed_events` itself (issue #120) is logged and does not stop the rest of the page from folding.
- A `ReorgDetectedError` is never quarantined, on either path — a genuine rewind still halts the indexer immediately, exactly as in [Reorg detection](#reorg-detection) above.
- Once the handler bug is fixed, `npm run reindex` folds a previously-quarantined event correctly with no extra step — it replays the raw log directly through `applyEvent`, independent of the poller's quarantine bookkeeping.
- Quarantined events are visible at `GET /api/admin/failed-events` (add `?unresolved=true` to see only the ones still outstanding) and counted in `GET /api/stats.quarantinedEvents`.
- **Recovering without a full reindex (issue #170).** `npm run replay-failed [-- --id <failed_events.id>]` re-folds a single quarantined event (or, with no `--id`, every unresolved one) directly through `applyEvent`, in its own transaction, under the same `REINDEX_LOCK_KEY` advisory lock a reindex uses — so it never races the live poller or a concurrent reindex. It is a script, not an API endpoint, deliberately: nothing HTTP-reachable can trigger a replay. It is idempotent — a record already marked `resolved_at` is skipped, and a fold keyed on `events.folded_at` (issue #119) is never double-applied — and a replay that still fails leaves the record's `error` and `resolved_at` untouched (still outstanding) rather than double-counting it as a new failure.
- **`resolved_at` (issue #168).** Both `npm run reindex` and `npm run replay-failed` mark a `failed_events` row `resolved_at = now()` once the event it refers to folds successfully — a reindex re-applies the entire raw log in one transaction, so completing it without error means every outstanding quarantine record was, in that same transaction, just proven fixed. The row itself is never deleted — the failure history (what failed, and why) is kept — only the count changes: `/api/stats.quarantinedEvents` and the default `GET /api/admin/failed-events` view count/list unresolved records only, so the figure means "still a live problem", not "ever happened".

### Docker

```bash
docker build -t ourdao-backend .
docker run --env-file .env -p 4000:4000 ourdao-backend            # API (default CMD)
docker run --env-file .env ourdao-backend node dist/worker.js      # indexer
docker run --env-file .env ourdao-backend node dist/indexer/reindex.js   # one-off rebuild
```

The image runs as the non-root `node` user, uses `tini` as PID 1, and has a `HEALTHCHECK` against `/health`. Both processes migrate on startup, so no separate migrate step is needed.

## Testing

```bash
# One-time: create the test database (separate from the dev DB above)
docker exec <postgres-container> psql -U ourdao -d postgres -c "CREATE DATABASE ourdao_test;"

npm test          # vitest, against ourdao_test — never touches dev data
npm run lint
npm run typecheck
```

145 tests across 18 files, covering:
- Event decode logic (`decodeEvent`, `toJsonSafe`) in isolation.
- Every indexer handler (membership, loan lifecycle including defaults, treasury, staking, registry, commit-reveal privacy, document attachments) against a real Postgres instance — not mocked.
- Required-field validation per handler (issue #42) and the poller's quarantine path for a deterministically-failing handler (issue #43), including that a genuine reorg is still never quarantined.
- The `last_ledger`/`observed_tip_ledger` split (issue #45): an empty page during catch-up doesn't produce a false reorg halt.
- Every API route, exercised through a real Fastify instance via `.inject()`.

Tests apply the real `schema.sql` and truncate all tables between runs (`test/db.ts`). CI runs all of the above plus `npm run build` against a Postgres service container on every push and PR (`.github/workflows/ci.yml`).

## Security notes

- **No custody, ever.** This service holds no private keys and has no code path that constructs, signs, or submits a transaction. It is a read model over public on-chain events.
- **Fail-soft, not fail-open.** If the indexer falls behind or the RPC endpoint is unreachable, reads degrade to stale/empty data (surfaced to the frontend as such) rather than the API crashing or serving incorrect state.
- **Database-pressure policy.** Health, readiness, and ordinary state reads (`/members`, proposals, loans, notifications, and event pages) have priority. `GET /api/stats` is the aggregate, lower-priority endpoint: only `STATS_MAX_CONCURRENT` cache-miss recomputations may run per API process (default 1). Further misses receive `503` with `Retry-After` instead of queueing for a database connection. If a recomputation fails after a prior success, the API returns that last value with `X-Data-Stale: true`; a first-ever failed computation still returns the normal database failure. This keeps useful reads available while making the degraded stats result explicit.
- **CORS is explicit.** `CORS_ORIGIN` defaults to `http://localhost:3000` in both code and config — a production deployment should set this to the real frontend origin. Setting it to `*` is supported as an explicit opt-in but logs a warning at startup.
- **Input handling.** All route parameters (addresses, ids, cursors) are validated before being used in parameterized queries — no raw string interpolation of attacker-influenceable values into SQL anywhere in the codebase. Stream notifications use `SELECT pg_notify($1, $2)` with bound parameters (issue #153); the shared listener's one-time `LISTEN` (issue #152) still interpolates channel names, drawn from the frozen `STREAM_CHANNELS` constant, never user input.
- **NOTIFY is isolated from the fold (issue #169).** The indexer's fold transaction only decides *which* stream channel changed; the actual `NOTIFY` is sent afterwards, once that transaction has committed, on a separate connection from the shared pool — never on the fold transaction's own client. A `NOTIFY` failure (oversized payload, a dropped connection) can therefore never roll back or otherwise affect a fold that already succeeded. Failures are logged as structured JSON (`src/logger.ts`) and counted in `GET /api/stats.notificationFailures`.
- **Supported authentication address types.** The signature-based auth on the notification mutation endpoints accepts:
  - **`G…` (ed25519)** — verified directly against the account's public key.
  - **`M…` (muxed)** — resolved to the underlying `G…` account and verified against its key. Sign the same `"<nonce>:<address>"` payload using the `M…` address as it appears in the header.
  - **`C…` (contract) accounts are not supported.** A Soroban contract account has no ed25519 key and authorizes through its `__check_auth` entrypoint, which requires an on-chain RPC call to verify. Authenticating with a `C…` address returns `400` with an explicit message rather than a misleading `401 "Invalid signature"`. If contract-wallet auth is needed, open an issue — it needs an RPC call in the auth path and a caching strategy.
- **Nonce reuse prevents denial-of-service.** When a nonce is requested for an address that already has a valid unexpired nonce, `issue()` returns the existing nonce instead of overwriting it. This prevents an attacker from invalidating a victim's pending nonce by requesting a new challenge for the victim's address, and also prevents self-invalidation when a user opens multiple tabs. Nonces expire after 5 minutes. Note: this behavior addresses one denial-of-service vector, but several related issues remain open: consume-before-verify ordering (#115), unchecked store capacity reporting (#135), non-atomic nonce operations, and the nonce's changed secrecy properties.
- **Dependency Scanning.** Dependencies are scanned weekly via Dependabot, and `npm audit` is run in CI to report on vulnerabilities.
- **Rate limiting.** Global rate limiting (`@fastify/rate-limit`) is applied to all API endpoints, with a stricter per-route limit on `GET /api/events`. Health and readiness probes are exempt. Behind a reverse proxy, set `TRUST_PROXY=true` so limits apply per client IP. With in-process limiting, the effective global limit is `RATE_LIMIT_MAX × instance count`.
- **`GET /api/stream` rate-limit treatment (issue #158).** The stream route is registered inside the `/api` plugin (same prefix and encapsulation as every other route) and is **not** exempt from the global request rate limiter — the initial handshake is a request and counts toward `RATE_LIMIT_MAX`. A long-lived open socket is not a request in the sense the limiter models, so open connections are bounded separately by `STREAM_MAX_CONNECTIONS` / `STREAM_MAX_CONNECTIONS_PER_IP` (issue #156); exceeding either returns `503` with `Retry-After`. The live count is exposed as `connectedStreams` on `GET /api/stats`.
- **`GET /api/stream` is unauthenticated by design, and broadcasts only DAO-wide state (issue #160).** It never requires a wallet signature — any client can connect and `LISTEN` — but every channel it can subscribe to (`members`, `loan_proposals`, `loans`, `treasury_proposals`, `interest`) describes state that's already public via the corresponding `GET` endpoints; a connected client learns nothing an unauthenticated caller couldn't already fetch directly. There is deliberately no per-member channel: a member's own notification feed (loan amounts, defaults, private-vote participation) is only ever available from the authenticated `GET /api/notifications`, and clients are expected to poll that themselves rather than have it pushed over an unauthenticated stream. A client that only cares about a subset of state can request it with `?channels=loans,loan_proposals` (comma-separated `STREAM_CHANNELS` keys) instead of receiving every channel.

## Status

MVP — the indexer and read API are implemented for the full event catalog, including loan defaults, with test coverage across every indexer handler and API route. Known gaps:

- Reorg handling is *detection only* — the indexer halts on a ledger discontinuity and an operator rebuilds derived state from the raw log with `npm run reindex` (see [Reorg detection](#reorg-detection) and the runbook in [`docs/REORG_RECOVERY.md`](./docs/REORG_RECOVERY.md)). There is no automatic rollback and replay of orphaned events.
- Single indexer instance — no leader-election or multi-instance coordination if you wanted to run more than one worker for redundancy.
- IPFS pinning for document metadata is a frontend/contract-facing concern (`ourdao-frontend`'s `lib/ipfs.ts`) — this service indexes `doc_attn`'s existence/history (`documents`, `GET /api/documents`) but never the content hash or its content.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, how to run the test suite against a real Postgres, and the backend-specific rules (read-only boundary, append-only event log, transactional event folding). Please claim an issue before opening a pull request.

Found a security vulnerability? Don't open a public issue — use GitHub's private vulnerability reporting on this repo.

## License

MIT

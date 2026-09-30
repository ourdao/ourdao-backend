# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Operational Flags
Entries that affect deployment or runtime state are annotated:
- **`[Migration: <file>]`** — Release carries a schema migration applied on startup.
- **`[Requires Reindex]`** — Deployment requires running `npm run reindex` after startup.

---

## [Unreleased]

### Added
- **`/api/members/:address/activity?symbol=`**: filter a member's activity feed to one event kind. Only the member-activity symbols are accepted (the OpenAPI enum lists them); anything else is `400 VALIDATION_FAILED`/`BAD_REQUEST` rather than an empty page. Query plans with and without the filter at 300k rows are recorded in `docs/member-activity-query-plan.md`; no new index was warranted (#193).
- **`/api/admin/failed-events` filters and total**: `?symbol=`, `?from_ledger=`/`?to_ledger=` (same validation as `/api/events`), composable with the existing `?before=` cursor and `?unresolved=`; every response carries `X-Total-Count`, the size of the filtered quarantine independent of the page (#192).
- **Persisted reorg halts**: a detected ledger discontinuity is written to the new `reorg_halts` table before the worker exits, `/ready` reports it as `reason: reorg_detected` (distinct from `indexer_stale`), `/api/stats` gains `reorgDetected` and `reorgHalt`, and the worker refuses to start while a halt is uncleared. `npm run reindex` clears it as part of the rebuild; `npm run reorg:clear` acknowledges a false alarm. Operator procedure in `docs/DEPLOYMENT.md` and `docs/REORG_RECOVERY.md` **[Migration: 0030_reorg_halts.sql]** (#191).
- **Machine-readable error codes**: every error response now carries a stable `code` from an append-only enum (`ERROR_CODES` in `src/api/errors.ts`), documented in the README's Errors table; route-level `4xx` bodies also gain `correlationId`. Additive — `error` is unchanged (#186).
- **Explicit server limits**: `HTTP_BODY_LIMIT_BYTES` (16 KiB), `HTTP_REQUEST_TIMEOUT_MS` (30s), `HTTP_CONNECTION_TIMEOUT_MS` (60s), `HTTP_KEEP_ALIVE_TIMEOUT_MS` (72s); `maxParamLength` pinned at 100. Stalled requests get `408 REQUEST_TIMEOUT`, oversized bodies `413 PAYLOAD_TOO_LARGE` (#187).
- **`/api/documents` open listing**: `kind` and `proposal_id` are optional and a `caller` filter is added; the per-proposal query is unchanged **[Migration: 0025_documents_listing_indexes.sql]** (#189).
- **Connection budget docs**: `docs/DEPLOYMENT.md` states where SSE clients fit (one listener connection per instance, bounded by `STREAM_MAX_CONNECTIONS`), the pre-#152 deadlock condition, and a worked example with streams (#188).
- **Named Cache-Control policies**: `public-live`, `public-historical`, `private`, `no-store` in `src/api/cache-policy.ts`; unset routes default to `no-store`, authenticated requests are never shared-cacheable, and a test fails on an ad-hoc directive (#194). `/admin/failed-events` and the SSE stream now send `no-store`.
- **Migration reversibility policy**: forward-only, backward-compatible with the previous release; every migration carries a `-- compat:` annotation enforced by test, existing migrations audited, and a rollback procedure added to `docs/DEPLOYMENT.md` (#197).
- **Pool tuning**: `DB_IDLE_TIMEOUT_MS`, `DB_APPLICATION_NAME`, per-process `application_name` (`ourdao-api`, `ourdao-worker`, `ourdao-reindex`); reindex and migrations lift `statement_timeout` for themselves only (#196).
- **Image Vulnerability Scanning**: Added Trivy container image vulnerability scanning to CI `docker-build` job with failure policy on HIGH/CRITICAL and allowlist support via `.trivyignore` (#212).
- **Base Image Digest Pinning**: Pinned Docker base image to `node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293` with automated Dependabot updates (#212).
- **Mutation Testing**: Evaluated and configured Stryker for high-risk modules `src/indexer/handlers.ts` and `src/api/errors.ts` (#209).
- **Soroban RPC Response Shape Smoke Test**: Added opt-in scheduled smoke test verifying real RPC wire response compatibility without mocking, pinned to SDK version 16.0.1 (#206).
- **Changelog & Versioning**: Established `CHANGELOG.md`, versioning policy, and deployment tracking (#213).
- **Reorg recovery runbook**: `docs/REORG_RECOVERY.md` — how the indexer detects a ledger discontinuity, the `indexer_cursor` fields involved (`last_ledger`, `last_ledger_hash`, `observed_tip_ledger`), diagnostic SQL for cursor state, triage, and the step-by-step operator recovery. Linked from the README's Reorg detection section and `docs/DEPLOYMENT.md` (#297).


### Fixed
- **Cursor pages are no longer cached for a year as `immutable`**: the `public-historical` policy is now `public, max-age=3600, must-revalidate`, so a wrong page (a filtering bug, a shape change) can be waited out within an incident instead of sitting in every cache with no URL version to bust it. Applies to `/api/events`, `/api/admin/log`, `/api/interest` and `/api/documents` cursor pages; a test bounds every policy to one hour and forbids `immutable`. The README's Caching section now lists the policy per endpoint (#190).
- **`main` builds again**: merge-damaged sources (`src/config.ts`, `src/api/routes/index.ts`, duplicate imports in the poller, an `ioredis` import with no dependency, OpenTelemetry 2.x code against 1.x pins), a `package-lock.json` missing eight packages, `@fastify/compress` 7 against Fastify 5, three migrations numbered `0026` (renumbered `0028`, `0029`), `failed_events.resolution` columns missing from `schema.sql`, and tests that had drifted from `#186`'s error envelope and `#289`'s cursor keying.
- **Duplicate migration version 22**: `0022_auth_nonces_rekey.sql` renumbered `0024` and annotated breaking; it no longer fails with `relation "auth_nonces_expires_at_idx" already exists` on a database that predates it **[Migration: 0024_auth_nonces_rekey.sql]**. Swagger/OpenAPI registration restored in `buildServer`.
- **`withLoanDerived`** no longer throws on a malformed amount: the row's `interest_charge`/`repaid_amount` are `null` instead of a `500` for the whole list; a test asserts every `NUMERIC` column keeps scale zero (#195).
- **Duplicate migration version 21**: `0021_quarantine_state.sql` renumbered `0023` **[Migration: 0023_quarantine_state.sql]**. `schema.sql` now includes `quarantine_state` and the 0022 `failed_events` uniqueness, and the quarantine-state upsert no longer references an invalid column.

---

## [0.2.0] - 2026-09-27

### Added
- **Stream hardening**: Dedicated shared `LISTEN` connection per process preventing request pool exhaustion (#152).
- **Stream reconnection**: SSE `id:` now carries monotonic ledger sequence numbers; reconnecting clients receive a `resync` event on stale/current/absent `Last-Event-ID` (#155).
- **Stream backpressure**: SSE client backpressure detection with stalled client disconnects (#157, #160).
- **Configurable ledger close time**: Extracted `STELLAR_LEDGER_CLOSE_TIME_SECONDS` constant (default 5s) for consistent `estimatedLagSeconds` reporting across `/ready` and `/api/stats` (#139).
- **Missing event folding**: Handled `loan_wait`, `loan_rej`, `tre_wait`, `tre_rej` events into derived tables and restored `tallies_weighted` flag (#123, #124, #125, #126).
- **Ledger hash reorg detection**: Stored folded ledger hash in `indexer_cursor` to detect same-height chain forks (#128). `[Migration: 0015_events_ledger_id_idx.sql]`
- **Cold start handling**: Correctly treated null `indexer_cursor.updated_at` as cold start in `/ready` (#129).
- **Authentication**: Added Postgres-backed nonce store (`0018_auth_nonces.sql`), signature verification before nonce consumption, and muxed address resolution (#115, #116, #117, #118). `[Migration: 0018_auth_nonces.sql]`
- **Events folded timestamp**: Added `folded_at` timestamp column to `events` table (#120). `[Migration: 0016_events_folded_at.sql]`
- **Loan proposal status**: Added `ApprovedPendingDisbursement` status support (#125). `[Migration: 0017_approved_pending_disbursement_status.sql]`
- **Event decode error recording**: Added `decode_error` column to track decoding failures in `events` table (#122). `[Migration: 0019_events_decode_error.sql]`
- **Notifications event tracking**: Linked notifications to originating event ID (#121). `[Migration: 0020_notifications_event_id.sql]`

### Changed
- **Unified Error Envelope**: All API error responses now follow a consistent `{ error: string, correlationId: string }` envelope with no raw Postgres internal text leaked (#81).
- **Version Endpoint**: `/version` caches `package.json` version once at startup instead of reading disk on every request (#166).
- **Member contribution share**: Switched to active-member denominator for `contribution_share_bps` calculation (#163).
- **CI audit**: Enforced strict `npm audit --audit-level=high` in CI (#131).
- **Duplicate migration protection**: Added duplicate detection and fixed colliding migrations (#127).

### Fixed
- **Stream crash prevention**: Guarded against malformed Postgres `NOTIFY` payloads crashing the process (#154).
- **Advisory lock resilience**: Ensured indexer and reindex advisory lock handling releases cleanly (#137).
- **Vote weight validation**: Validated non-negative vote weights in event handlers (#136).
- **Admin errors leak**: Sanitized raw exception messages in `/api/admin/failed-events` (#164).

---

## [0.1.0] - 2026-09-24

### Added
- **Initial Release**: Off-chain indexer and read API for OurDAO on Stellar/Soroban.
- **Worker & API Architecture**: Two-process topology sharing a Postgres database.
- **Event Indexing**: Core decoding and folding for `joined`, `exited`, `claimed`, `loan_req`, `loan_appr`, `loan_rpy`, `loan_dflt`, `tre_prop`, `tre_exec`, `staked`, `unstaked`.
- **Database Schema**: Initial migrations `0001` through `0013` covering members, loans, proposals, documents, events, cursor, and status check constraints. `[Migration: 0001-0013]`
- **REST Endpoints**: `/health`, `/ready`, `/version`, `/api/members`, `/api/loans`, `/api/proposals`, `/api/stats`, `/api/events`, `/api/documents`, `/api/stream`.
- **Reindex Tooling**: `npm run reindex` for rebuilding derived tables from raw event history.

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
- **Named Cache-Control policies**: `public-live`, `public-historical`, `private`, `no-store` in `src/api/cache-policy.ts`; unset routes default to `no-store`, authenticated requests are never shared-cacheable, and a test fails on an ad-hoc directive (#194). `/admin/failed-events` and the SSE stream now send `no-store`.
- **Migration reversibility policy**: forward-only, backward-compatible with the previous release; every migration carries a `-- compat:` annotation enforced by test, existing migrations audited, and a rollback procedure added to `docs/DEPLOYMENT.md` (#197).
- **Pool tuning**: `DB_IDLE_TIMEOUT_MS`, `DB_APPLICATION_NAME`, per-process `application_name` (`ourdao-api`, `ourdao-worker`, `ourdao-reindex`); reindex and migrations lift `statement_timeout` for themselves only (#196).
- **Image Vulnerability Scanning**: Added Trivy container image vulnerability scanning to CI `docker-build` job with failure policy on HIGH/CRITICAL and allowlist support via `.trivyignore` (#212).
- **Base Image Digest Pinning**: Pinned Docker base image to `node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293` with automated Dependabot updates (#212).
- **Mutation Testing**: Evaluated and configured Stryker for high-risk modules `src/indexer/handlers.ts` and `src/api/errors.ts` (#209).
- **Soroban RPC Response Shape Smoke Test**: Added opt-in scheduled smoke test verifying real RPC wire response compatibility without mocking, pinned to SDK version 16.0.1 (#206).
- **Changelog & Versioning**: Established `CHANGELOG.md`, versioning policy, and deployment tracking (#213).


### Fixed
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

import 'dotenv/config'

export function str(env: NodeJS.ProcessEnv, name: string, fallback = ''): string {
  const v = env[name]
  return v === undefined || v === '' ? fallback : v
}

export function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v.trim())
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback
}

export function bool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

/** Pino log levels as documented at https://getpino.io/#/docs/api?id=level */
const PINO_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

/** Parse a log level string, falling back to 'info' if invalid or empty. */
export function logLevel(env: NodeJS.ProcessEnv, name: string, fallback = 'info'): string {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const level = v.trim().toLowerCase()
  return PINO_LEVELS.has(level) ? level : fallback
}

const NONCE_STORES = new Set(['postgres', 'memory'])

/**
 * Parse the NONCE_STORE env var, falling back to 'postgres' (with a logged
 * warning) for anything unrecognized. An unvalidated typo here used to
 * silently downgrade to the in-memory store — the exact multi-instance auth
 * failure issue #66 was filed to fix (issue #118).
 */
export function nonceStore(env: NodeJS.ProcessEnv, name: string, fallback: 'postgres' | 'memory' = 'postgres'): 'postgres' | 'memory' {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const value = v.trim().toLowerCase()
  if (NONCE_STORES.has(value)) return value as 'postgres' | 'memory'
  console.warn(`[config] Invalid NONCE_STORE "${v}" — falling back to "${fallback}". Expected one of: ${[...NONCE_STORES].join(', ')}`)
  return fallback
}

/**
 * Parse the CORS_ORIGIN env var into a Fastify-compatible origin value.
 *
 * - `"*"` → `"*"` (opt-in to wide-open CORS, triggers a warning)
 * - Comma-separated list → trimmed, de-deduplicated, empty entries dropped
 * - Unset / empty → `"http://localhost:3000"` (safe default)
 *
 * Exported so tests can exercise it without fighting import-time side effects.
 */
export function parseCorsOrigin(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return 'http://localhost:3000'
  if (trimmed === '*') return '*'
  const origins = [...new Set(trimmed.split(',').map((o) => o.trim()).filter(Boolean))]
  return origins.length === 1 ? origins[0]! : origins.join(',')
}

/** Resolved runtime configuration, read once at import time. */
export function resolveConfig(env: NodeJS.ProcessEnv) {
  return {
  http: {
    port: int(env, 'PORT', 4000),
    host: str(env, 'HOST', '0.0.0.0'),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN),
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 100),
    rateLimitWindowMs: int(env, 'RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitEventsMax: int(env, 'RATE_LIMIT_EVENTS_MAX', 30),
    trustProxy: str(env, 'TRUST_PROXY', 'false'),
    // How long (ms) an in-process /api/stats result is reused before it is
    // recomputed (issue #18). A burst of polls inside this window collapses
    // to one set of queries. The reported figures — counts and the freshness
    // signal alike — are then at most this stale, which is well under
    // INDEXER_STALE_AFTER_MS. In-process only: with more than one API
    // instance they may briefly disagree.
    statsCacheMs: int(env, 'STATS_CACHE_MS', 5_000),
    // Aggregate stats are intentionally lower priority than ordinary reads.
    // Do not queue concurrent recomputations: a full slot sheds immediately
    // so members, proposals, and loan reads keep a connection available.
    statsMaxConcurrent: int(env, 'STATS_MAX_CONCURRENT', 1),
    statsRetryAfterSeconds: int(env, 'STATS_RETRY_AFTER_SECONDS', 1),
    // Issue #156: concurrent SSE stream bounds. Open streams no longer each
    // cost a database connection (issue #152 — they share one process-wide
    // LISTEN connection), but still cost a socket/file descriptor and a
    // small amount of memory each, so these caps remain the real resource
    // bound (the request rate limiter only covers connection attempts).
    streamMaxConnections: int(env, 'STREAM_MAX_CONNECTIONS', 100),
    streamMaxConnectionsPerIp: int(env, 'STREAM_MAX_CONNECTIONS_PER_IP', 10),
    streamIdleTimeoutMs: int(env, 'STREAM_IDLE_TIMEOUT_MS', 60_000),
    streamRetryAfterSeconds: int(env, 'STREAM_RETRY_AFTER_SECONDS', 30),
    // Pino log level for the Fastify server (fatal, error, warn, info, debug, trace, silent).
    // 'silent' suppresses all request logging, which the test harness uses.
    logLevel: logLevel(env, 'LOG_LEVEL', 'info'),
    // Issue #167: /ready races its Postgres check against this timeout so a
    // hung database (mid-failover, an exhausted pool) reports `503` within a
    // bounded time instead of leaving the orchestrator to time out the HTTP
    // request itself — which loses the real reason ("postgres_unreachable")
    // and never sends a response body. Kept below typical liveness/readiness
    // probe timeouts (a few seconds) so it always resolves first.
    readyCheckTimeoutMs: int(env, 'READY_CHECK_TIMEOUT_MS', 3_000),
  },
  db: {
    // pg reads PG* env vars automatically; connectionString wins when set.
    connectionString: str(env, 'DATABASE_URL') || undefined,
    // Nonce store implementation: 'postgres' for production (multi-instance), 'memory' for testing (issue #66)
    nonceStore: nonceStore(env, 'NONCE_STORE', 'postgres'),
    // Issue #152: explicit request-pool size instead of relying on
    // node-postgres's implicit default (also 10). Made explicit — and
    // configurable — now that /api/stream no longer takes a connection per
    // client (see src/api/stream.ts's shared listener), so this pool is
    // sized for ordinary request concurrency only.
    poolMax: int(env, 'DB_POOL_MAX', 10),
    // Issue #167: how long a client may wait for a free connection from the
    // pool before pg gives up with a connection-timeout error, rather than
    // waiting forever when the pool is exhausted or Postgres is unreachable.
    connectionTimeoutMs: int(env, 'DB_CONNECTION_TIMEOUT_MS', 5_000),
    // Issue #167: server-side `statement_timeout` applied to every
    // connection this pool opens (via pg's `Pool` `statement_timeout`
    // option), so a query against a database that accepted the connection
    // but then hangs (mid-failover, a stuck lock) is killed by Postgres
    // itself instead of blocking the caller indefinitely. 10s comfortably
    // covers this codebase's heaviest query (reindex uses its own
    // long-lived connection, not this pool, and is unaffected).
    statementTimeoutMs: int(env, 'DB_STATEMENT_TIMEOUT_MS', 10_000),
    // Issue #196: how long an idle pooled connection is kept before being
    // closed (pg's own default, 30s, made explicit and tunable). `0` disables
    // idle eviction.
    idleTimeoutMs: int(env, 'DB_IDLE_TIMEOUT_MS', 30_000),
    // Issue #196: shown in `pg_stat_activity.application_name` so the API,
    // the worker and one-off reindexes sharing a database can be told apart.
    // An explicit DB_APPLICATION_NAME wins; otherwise it is derived from the
    // process role (`OURDAO_PROCESS_ROLE`, set by src/worker.ts before the
    // pool is created, defaulting to `api`).
    applicationName: str(env, 'DB_APPLICATION_NAME') || `ourdao-${str(env, 'OURDAO_PROCESS_ROLE', 'api')}`,
  },
  stellar: {
    contractId: str(env, 'CONTRACT_ID'),
    rpcUrl: str(env, 'SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org'),
    networkPassphrase: str(env, 'NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015'),
    // Stellar's nominal ledger close time (issue #139) — used by `/ready` to
    // turn a ledger-count lag into an estimated seconds-behind figure. Not an
    // SLA; the network can and does close slower or faster than this.
    ledgerCloseTimeSeconds: int(env, 'STELLAR_LEDGER_CLOSE_TIME_SECONDS', 5),
  },
  indexer: {
    startLedger: int(env, 'START_LEDGER', 0),
    startLookbackLedgers: int(env, 'START_LOOKBACK_LEDGERS', 17280),
    pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 5000),
    pageLimit: int(env, 'EVENTS_PAGE_LIMIT', 100),
    // Cap for the exponential backoff applied after consecutive poll failures.
    maxBackoffMs: int(env, 'POLL_MAX_BACKOFF_MS', 60_000),
    // Max pages to drain per poll iteration (issue #3).
    maxDrainPages: int(env, 'DRAIN_MAX_PAGES', 20),
    // Max wall-clock ms for a single drain cycle (issue #3).
    maxDrainMs: int(env, 'DRAIN_MAX_MS', 30_000),
    // How long (ms) the indexer cursor can be idle before /ready reports stale.
    staleAfterMs: int(env, 'INDEXER_STALE_AFTER_MS', 120_000),
    // After this many consecutive whole-page failures with the same error on
    // the same page, the poller treats the failure as deterministic rather
    // than transient and quarantines the offending event(s) instead of
    // retrying forever (issue #43).
    quarantineAfterFailures: int(env, 'INDEXER_QUARANTINE_AFTER_FAILURES', 3),
    // When CONTRACT_ID no longer matches the contract the saved cursor was
    // last advanced for (a redeploy — the contract has no upgrade path), the
    // indexer refuses to start so two deployments' state can't merge (issue
    // #16). Set this to `true` for exactly one boot to wipe the cursor and
    // every derived table and re-index the new contract from scratch. The
    // raw `events` log is left intact as an audit trail.
    resetOnContractChange: bool(env, 'INDEXER_RESET_ON_CONTRACT_CHANGE', false),
  },
  } as const
}

/** Resolved runtime configuration, read once at import time. */
export const config = resolveConfig(process.env)

export type Config = typeof config

export function assertContractConfigured(resolvedConfig: Config = config): string {
  if (!resolvedConfig.stellar.contractId) {
    throw new Error(
      'CONTRACT_ID is not set. The indexer needs the deployed OurDAO contract id to poll events.'
    )
  }
  return resolvedConfig.stellar.contractId
}

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

/**
 * Parses `STELLAR_RPC_HEADERS` (issue #284) into the header map
 * `rpc.Server`'s `headers` option expects, so a managed Soroban RPC provider
 * (QuickNode and similar) that requires an API key or bearer token can be
 * authenticated against. Format: `Name1:Value1,Name2:Value2` — a colon
 * separates each header's name from its value, a comma separates entries.
 * A value may itself contain colons (e.g. `Authorization:Bearer abc:def`);
 * only the first colon in an entry is treated as the separator.
 *
 * Malformed entries (no colon, or an empty name) are skipped with a warning
 * rather than silently producing a broken header, since a header the RPC
 * provider doesn't recognize fails requests in a way that's hard to trace
 * back to a config typo.
 */
export function parseStellarRpcHeaders(raw: string | undefined): Record<string, string> {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return {}

  const headers: Record<string, string> = {}
  for (const entry of trimmed.split(',')) {
    const piece = entry.trim()
    if (!piece) continue
    const separatorIndex = piece.indexOf(':')
    // separatorIndex <= 0 covers both "no colon at all" (-1) and "colon is
    // the first character" (0, an empty name) in one check.
    if (separatorIndex <= 0) {
      console.warn(`[config] Ignoring malformed STELLAR_RPC_HEADERS entry (expected "Name:Value"): "${piece}"`)
      continue
    }
    const name = piece.slice(0, separatorIndex).trim()
    const value = piece.slice(separatorIndex + 1).trim()
    headers[name] = value
  }
  return headers
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
    // Issue #187: server limits set deliberately rather than inherited.
    // Max request body. The API is read-only — the only non-GET routes are
    // two body-less PATCHes — so Fastify's 1 MiB default is far more than
    // any legitimate request needs.
    bodyLimitBytes: int(env, 'HTTP_BODY_LIMIT_BYTES', 16 * 1024),
    // Max time to receive a *complete request* (headers and body) — not the
    // response, so long-lived SSE streams are unaffected. Without it a client
    // can dribble a partial request and hold a socket forever. `0` disables.
    requestTimeoutMs: int(env, 'HTTP_REQUEST_TIMEOUT_MS', 30_000),
    // Socket inactivity timeout. Must stay above the SSE heartbeat interval
    // (30s) so an idle-but-healthy stream is never cut. `0` disables.
    connectionTimeoutMs: int(env, 'HTTP_CONNECTION_TIMEOUT_MS', 60_000),
    // How long an idle keep-alive socket is held between requests. Keep it
    // above the load balancer's idle timeout (60s on AWS ALB, for example),
    // otherwise the LB can reuse a socket the server just closed → 502s.
    keepAliveTimeoutMs: int(env, 'HTTP_KEEP_ALIVE_TIMEOUT_MS', 72_000),
  },
  db: {
    // pg reads PG* env vars automatically; connectionString wins when set.
    connectionString: str(env, 'DATABASE_URL') || undefined,
    // Nonce store implementation: 'postgres' for production (multi-instance), 'memory' for testing (issue #66)
    nonceStore: nonceStore(env, 'NONCE_STORE', 'postgres'),
    // Issue #181: nonce TTL and sweep intervals are now configurable
    nonceTtlMs: int(env, 'NONCE_TTL_MS', 5 * 60 * 1000),
    nonceMaxEntries: int(env, 'NONCE_MAX_ENTRIES', 10000),
    nonceSweepIntervalMs: int(env, 'NONCE_SWEEP_INTERVAL_MS', 60 * 1000),
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
    // Issue #289: multi-contract tailing (e.g. a governance DAO contract and
    // a separate treasury vault contract) in one indexer process. CONTRACT_IDS
    // is a comma-separated list and takes priority when set; CONTRACT_ID alone
    // still works unchanged for existing single-contract deployments. Blank
    // entries from stray commas/whitespace are dropped rather than producing
    // an empty-string "contract" the RPC would reject.
    contractIds: str(env, 'CONTRACT_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rpcUrl: str(env, 'SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org'),
    // Issue #284: custom headers (API key, bearer token) for managed/private
    // Soroban RPC providers. Never log this value — see parseStellarRpcHeaders.
    rpcHeaders: parseStellarRpcHeaders(env.STELLAR_RPC_HEADERS),
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
  // Issue #277: Redis is a strictly optional read-through cache for the
  // heaviest DAO reads (member list, per-address summary) — this is a
  // read-heavy DAO backend and neither local dev nor the test suite should
  // ever need a Redis instance. `redisUrl` unset means the cache helper
  // no-ops (see src/cache/redis.ts): every read falls straight through to
  // Postgres, exactly as before this issue.
  cache: {
    redisUrl: str(env, 'REDIS_URL') || undefined,
    // 30s matches the existing `statsCacheMs` precedent above for the same
    // class of problem: a burst of polls against the same key collapses to
    // one Postgres read, and clients are never stale by more than this.
    memberCacheTtlSeconds: int(env, 'MEMBER_CACHE_TTL_SECONDS', 30),
    // The /stats/history cache (src/api/history-cache.ts) shares the same
    // optional Redis instance.
    historyRedisUrl: str(env, 'REDIS_URL') || undefined,
  },
  // Issue #279: periodic VACUUM ANALYZE + expired-row cleanup, run from the
  // worker process (src/worker.ts) alongside the indexer loop.
  maintenance: {
    // Weekly by default — vacuuming is comparatively rare maintenance, not a
    // hot-path concern; configurable for operators who want it tighter.
    intervalMs: int(env, 'MAINTENANCE_INTERVAL_MS', 7 * 24 * 60 * 60 * 1000),
  },
  otel: {
    // Issue #288: tracing is opt-in — most local/dev/test runs have no OTLP
    // collector to send spans to, and OpenTelemetry's own SDK already
    // defaults to a no-op tracer when nothing registers a real provider, so
    // this just controls whether src/telemetry.ts bothers registering one.
    enabled: bool(env, 'OTEL_ENABLED', false),
    exporterOtlpEndpoint: str(env, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318/v1/traces'),
    serviceName: str(env, 'OTEL_SERVICE_NAME', 'ourdao-backend'),
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

/** Issue #289: resolves the full set of contract ids to tail. CONTRACT_IDS
 *  (comma-separated) takes priority; a single CONTRACT_ID is wrapped in a
 *  one-element array for existing single-contract deployments. Throws if
 *  neither is set, or if the same contract id appears more than once (that
 *  would mean two independent cursor rows racing to fold the same events). */
export function assertContractsConfigured(resolvedConfig: Config = config): string[] {
  if (resolvedConfig.stellar.contractIds.length > 0) {
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const id of resolvedConfig.stellar.contractIds) {
      if (seen.has(id)) dupes.add(id)
      seen.add(id)
    }
    if (dupes.size > 0) {
      throw new Error(`CONTRACT_IDS lists the same contract id more than once: ${[...dupes].join(', ')}`)
    }
    return resolvedConfig.stellar.contractIds
  }
  return [assertContractConfigured(resolvedConfig)]
}

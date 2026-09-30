import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { ServerOptions } from 'node:http'
import compress from '@fastify/compress'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import etag from '@fastify/etag'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { config } from '../config.js'
import { pool } from '../db/index.js'
import { registerCachePolicy } from './cache-policy.js'
import { clientErrorHandler, frameworkErrors, registerErrorHandling } from './errors.js'
import { registerRoutes } from './routes/index.js'
import { MemoryNonceStore, PostgresNonceStore, type NonceStore } from '../auth.js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { server as rpcServer } from '../stellar/rpc.js'
import { metricsRegistry } from './metrics.js'

interface ReorgHaltRow {
  contract_id: string
  last_ledger: number | null
  detail: string
  detected_at: string
}

interface CursorRow {
  last_ledger: number | null
  observed_tip_ledger: number | null
  updated_at: string | null
}

interface PackageJson {
  version: string
}

// Read once at module load — the version cannot change while the process
// is running, so there is no reason for `/version` to hit the filesystem
// on every request (issue #166). `/version` sits in the rate limiter's
// allowList alongside `/health` and `/ready`, so it is otherwise the one
// unthrottled endpoint that would do disk I/O per call.
function readPackageVersion(): { version: string; error?: unknown } {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(__dirname, '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson
    return { version: pkg.version }
  } catch (error) {
    return { version: 'unknown', error }
  }
}

const packageVersionResult = readPackageVersion()

// Issue #207: module-level storage for the nonce store so it can be shut down
// gracefully when the process exits. Set by buildServer(), accessed by
// shutdownNonceStore().
let activeNonceStore: NonceStore | null = null

/**
 * Shut down the active nonce store's timers (issue #207). Called from the
 * main process shutdown path (src/index.ts) before pool.end().
 */
export async function shutdownNonceStore(): Promise<void> {
  if (activeNonceStore && 'shutdown' in activeNonceStore) {
    await (activeNonceStore as { shutdown(): Promise<void> }).shutdown()
  }
}

export interface BuildServerOptions {
  /**
   * Override the Fastify logger. Production passes nothing and gets the
   * configured Pino logger; tests pass a capturing stream to assert that a
   * failure's full detail (and its correlation id) reach the log.
   */
  logger?: FastifyServerOptions['logger']
  /**
   * Extra Fastify options, applied last. Tests use it to shrink the server
   * timeouts (issue #187) to something a test can wait out.
   */
  serverOptions?: Partial<FastifyServerOptions> & { http?: ServerOptions }
}

/**
 * Longest path parameter the router accepts (Fastify's default, pinned —
 * issue #187). The longest legitimate one is a 56-character Stellar `G…`
 * address in `/members/:address`; ids are integers. Longer values get a 414.
 */
export const MAX_PARAM_LENGTH = 100

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: config.http.logLevel },
    trustProxy: config.http.trustProxy === 'true',
    // The request id doubles as the error-envelope correlation id (issue #81),
    // so make it a random uuid rather than the default per-process counter.
    genReqId: () => randomUUID(),
    // Issue #187: explicit limits instead of inherited defaults (see config.ts).
    bodyLimit: config.http.bodyLimitBytes,
    requestTimeout: config.http.requestTimeoutMs,
    connectionTimeout: config.http.connectionTimeoutMs,
    keepAliveTimeout: config.http.keepAliveTimeoutMs,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    clientErrorHandler,
    frameworkErrors,
    ...opts.serverOptions,
  })

  // One error shape for every failure — installed before routes so every child
  // context inherits it (issue #81).
  registerErrorHandling(app)

  // A failed package.json read is reported once at startup, rather than
  // silently returning 'unknown' from every future /version call — a
  // packaging mistake (e.g. the relative path resolving differently from
  // dist/ than from src/) should fail visibly, not forever (issue #166).
  if (packageVersionResult.error) {
    app.log.error({ err: packageVersionResult.error }, 'Failed to read package.json version; /version will report "unknown"')
  }

  // Select nonce store implementation based on config (issue #66)
  let nonceStore: NonceStore
  if (config.db.nonceStore === 'postgres') {
    nonceStore = new PostgresNonceStore(pool, app.log)
  } else {
    nonceStore = new MemoryNonceStore()
  }
  // Issue #207: store the nonce store for shutdown access
  activeNonceStore = nonceStore

  // Issue #182: register shutdown hook to clean up nonce store timers on close
  app.addHook('onClose', async () => {
    await nonceStore.shutdown()
  })

  // ── OpenAPI / Swagger (issue #215) ──
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'OurDAO Backend API',
        description: 'Off-chain indexer + read API for the OurDAO lending DAO on Stellar/Soroban',
        version: packageVersionResult.version,
      },
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Development server',
        },
      ],
      tags: [
        { name: 'health', description: 'Service health and readiness endpoints' },
        { name: 'stats', description: 'Aggregate statistics' },
        { name: 'members', description: 'DAO member operations' },
        { name: 'loans', description: 'Loan and loan proposal operations' },
        { name: 'treasury', description: 'Treasury proposal operations' },
        { name: 'notifications', description: 'Member notifications' },
        { name: 'events', description: 'Raw event feed' },
        { name: 'admin', description: 'Admin and governance operations' },
        { name: 'auth', description: 'Authentication operations' },
        { name: 'documents', description: 'Proposal document attachments' },
        { name: 'interest', description: 'Interest distribution history' },
      ],
    },
  } as const)

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  } as const)

  await app.register(etag)
  // Registered after etag so its onSend sees the final headers (issue #194).
  registerCachePolicy(app)

  // ── Compression (issue #282) ──
  // Registered after etag/cache-policy so both compute against the plain
  // response body; compress is the last onSend transform, applied only once
  // the payload and its headers are final. `threshold: 1024` skips the
  // gzip/brotli overhead on small JSON bodies where compressing would cost
  // more CPU than it saves in bytes — the endpoints this targets
  // (`/api/loans`, `/api/events`) return arrays large enough to clear it.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
  })

  // ── CORS ──
  const origins = config.http.corsOrigin
  if (origins === '*') {
    app.log.warn('CORS_ORIGIN is set to "*" — all origins are allowed. Set CORS_ORIGIN to a specific origin for production.')
  }
  await app.register(cors, {
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
  })

  // ── Rate limiting (issue #5) ──
  await app.register(rateLimit, {
    max: config.http.rateLimitMax,
    timeWindow: config.http.rateLimitWindowMs,
    keyGenerator: (req: { ip?: string; socket?: { remoteAddress?: string } }) => req.ip ?? req.socket?.remoteAddress ?? 'unknown',
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
    allowList: (req: { url: string }) => req.url === '/health' || req.url === '/ready' || req.url === '/version' || req.url === '/metrics',
  })

  // ── Routes (including /api/stream — issue #158) ──
  await app.register(registerRoutes, { prefix: '/api', nonceStore })

  // ── Liveness probe (issue #2) — no DB round trip ──
  app.get('/health', async () => ({ status: 'ok', contract: config.stellar.contractId || null }))

  // ── Dependency health indicators (issue #276) ──
  // Separate from `/health` (liveness — deliberately no DB round trip) and
  // `/ready` (a binary pass/fail probe for orchestrators). This endpoint is
  // for dashboards/alerting: it reports Postgres and Soroban RPC status
  // individually rather than collapsing them into one ready/not-ready bit,
  // so an operator can tell which dependency is degraded at a glance. Always
  // returns 200 — a dependency being down is reported in its own `status`
  // field, not via the HTTP status code.
  app.get('/health/dependencies', async () => {
    const timeout = (ms: number) =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('timed out')), ms)
      })

    const [postgres, rpc] = await Promise.all([
      (async () => {
        const startedAt = Date.now()
        try {
          await Promise.race([pool.query('SELECT 1'), timeout(config.http.readyCheckTimeoutMs)])
          return { status: 'ok' as const, latencyMs: Date.now() - startedAt }
        } catch (error) {
          return {
            status: 'error' as const,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })(),
      (async () => {
        const startedAt = Date.now()
        try {
          const health = await Promise.race([rpcServer.getHealth(), timeout(config.http.readyCheckTimeoutMs)]) as { status: string }
          return { status: health.status === 'healthy' ? ('ok' as const) : ('degraded' as const), latencyMs: Date.now() - startedAt }
        } catch (error) {
          return {
            status: 'error' as const,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })(),
    ])

    return { postgres, rpc }
  })

  // ── Version endpoint (issue #64) — build metadata ──
  app.get('/version', async () => ({
    version: packageVersionResult.version,
    commit: process.env.SOURCE_COMMIT ?? 'unknown',
    buildDate: process.env.BUILD_DATE ?? 'unknown',
  }))

  // ── Prometheus metrics (issue #274) — SSE connection count + message throughput ──
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', metricsRegistry.contentType)
    return metricsRegistry.metrics()
  })

  // ── Readiness probe (issue #2) — checks DB + indexer freshness ──
  app.get('/ready', async (_req, reply) => {
    // 1. Postgres reachable, and within a bounded time (issue #167). The
    // `catch` below only ever sees the query itself fail (refused, auth
    // error) — it never fired for a *hung* database, since `pool.query`
    // has no timeout of its own and just waits for a free connection
    // forever. Racing it against an explicit timeout here means a hung
    // database still answers `503` promptly instead of leaving the
    // orchestrator to time out the HTTP request itself, which reports a
    // generic probe timeout rather than `postgres_unreachable` and never
    // gets a response body out at all.
    let timedOut = false
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            timedOut = true
            reject(new Error('ready check timed out'))
          }, config.http.readyCheckTimeoutMs)
        }),
      ])
    } catch {
      return reply.code(503).send({
        status: 'not ready',
        reason: timedOut ? 'postgres_timeout' : 'postgres_unreachable',
      })
    }

    // 2. Indexer cursor state
    let row: CursorRow | null = null
    try {
      // Issue #289: indexer_cursor now has one row per tailed contract
      // instead of a single id=1 row. Freshness/readiness reflects the
      // *worst* (least recently updated) contract — the system as a whole
      // isn't ready if any one tailed contract has fallen behind — which is
      // also exactly the single-contract behavior when there's only one row.
      row = await pool
        .query<CursorRow>('SELECT last_ledger, observed_tip_ledger, updated_at FROM indexer_cursor ORDER BY updated_at ASC NULLS FIRST LIMIT 1')
        .then((r) => r.rows[0] ?? null)
    } catch {
      // Table may not exist yet — treat as cold start
    }

    // 3. A recorded, uncleared ledger discontinuity (issue #191). Reported
    // before staleness and before cold start: the worker halted on purpose,
    // a restart is the wrong response, and an orchestrator must not read
    // the resulting idle cursor as an ordinary `indexer_stale`.
    let halt: ReorgHaltRow | null = null
    try {
      halt = await pool
        .query<ReorgHaltRow>(
          'SELECT contract_id, last_ledger, detail, detected_at FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1'
        )
        .then((r) => r.rows[0] ?? null)
    } catch {
      // Table may not exist yet on a database that predates migration 0030.
    }
    if (halt) {
      return reply.code(503).send({
        status: 'not ready',
        reason: 'reorg_detected',
        reorg: {
          detectedAt: new Date(halt.detected_at).toISOString(),
          contractId: halt.contract_id,
          lastLedger: halt.last_ledger,
          detail: halt.detail,
        },
        lastIndexedLedger: row?.last_ledger ?? null,
        observedTipLedger: row?.observed_tip_ledger ?? null,
      })
    }

    if (!row || row.last_ledger === null || row.updated_at === null) {
      return reply.code(200).send({
        status: 'ready',
        indexer: 'cold_start',
        lastIndexedLedger: null,
        observedTipLedger: row?.observed_tip_ledger ?? null,
        ledgersBehind: null,
        estimatedLagSeconds: null,
        secondsSinceUpdate: null,
      })
    }

    const updatedAt = new Date(row.updated_at).getTime()
    const secondsSinceUpdate = Math.floor((Date.now() - updatedAt) / 1000)
    const isStale = Date.now() - updatedAt > config.indexer.staleAfterMs
    const lastLedger = row.last_ledger
    const tipLedger = row.observed_tip_ledger
    const ledgersBehind = lastLedger != null && tipLedger != null && tipLedger > lastLedger
      ? tipLedger - lastLedger
      : null
    const estimatedLagSeconds = ledgersBehind != null
      ? ledgersBehind * config.stellar.ledgerCloseTimeSeconds
      : null

    if (isStale) {
      return reply.code(503).send({
        status: 'not ready',
        reason: 'indexer_stale',
        lastIndexedLedger: lastLedger,
        observedTipLedger: tipLedger,
        ledgersBehind,
        estimatedLagSeconds,
        secondsSinceUpdate,
        staleAfterMs: config.indexer.staleAfterMs,
      })
    }

    return reply.code(200).send({
      status: 'ready',
      indexer: 'ok',
      lastIndexedLedger: lastLedger,
      observedTipLedger: tipLedger,
      ledgersBehind,
      estimatedLagSeconds,
      secondsSinceUpdate,
    })
  })

  return app
}

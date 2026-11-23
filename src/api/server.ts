import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { ServerOptions } from 'node:http'
import compress from '@fastify/compress'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import etag from '@fastify/etag'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { config } from '../config.js'
import { pool } from '../db/index.js'
import { registerCachePolicy } from './cache-policy.js'
import { clientErrorHandler, frameworkErrors, registerErrorHandling } from './errors.js'
import { registerRoutes } from './routes/index.js'
import { registerStreamEndpoint } from './stream.js'
import { MemoryNonceStore, PostgresNonceStore, type NonceStore } from '../auth.js'
import { register as metricsRegister } from './metrics.js'
import {
  clearRequestSpan,
  getTracer,
  isTelemetryEnabled,
  requestSpan,
  setRequestSpan,
} from '../telemetry.js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { closeRedis } from '../cache/redis.js'
import { metricsRegistry } from './metrics.js'
import { server as rpcServer } from '../stellar/rpc.js'
import type { ReorgHalt } from '../indexer/poller.js'

interface CursorRow {
  last_ledger: number | null
  observed_tip_ledger: number | null
  updated_at: string | null
}

// Postgres SQLSTATE 42P01 (undefined_table). Issue #347: `/ready` only treats
// this as "the table was never created" — any other failure (statement
// timeout, dropped connection, permission error) leaves the indexer state
// unknown and must not read as a cold start.
const PG_UNDEFINED_TABLE = '42P01'

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === PG_UNDEFINED_TABLE
}

interface PackageJson {
  version: string
}

interface PackageVersionResult {
  version: string
  error?: unknown
}

// Helper to read package.json version
function readPackageVersion(): PackageVersionResult {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(__dirname, '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson
    return { version: pkg.version }
  } catch (error) {
    return { version: 'unknown', error }
  }
}

/** The four columns server.ts reads off reorg_halts for /ready's uncleared-halt check. */
type ReorgHaltRow = Pick<ReorgHalt, 'contract_id' | 'last_ledger' | 'detail' | 'detected_at'>

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
  /**
   * Override the AuthFailureTracker instance. Production passes nothing and
   * gets a fresh one; tests pass their own so they can inspect/seed its state
   * (e.g. to assert the same tracker instance observes auth attempts across
   * every route that wires it in — issue #603).
   */
  authFailureTracker?: AuthFailureTracker
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

  // ── Security headers (issue #298) ──
  // Registered first, at the root scope, so every response — API routes, the
  // probes, the Prometheus scrape, the error envelope and the Swagger UI —
  // carries the same hardening headers, and a route added later cannot
  // silently opt out of them.
  //
  // The CSP is spelled out (`useDefaults: false`) instead of inheriting
  // Helmet's defaults because two of those defaults are wrong for this
  // service: `style-src https:` / `font-src https:` allow any origin for a
  // process that serves only same-origin assets, and
  // `upgrade-insecure-requests` would rewrite the Swagger UI's own
  // same-origin asset URLs to `https://localhost` whenever the API is reached
  // over plain HTTP (local development), breaking `/docs` instead of
  // protecting anything. `style-src 'unsafe-inline'` stays because Swagger UI
  // injects its own inline styles; scripts are same-origin files only.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        // Clickjacking: the API may never be framed. `frame-ancestors` covers
        // CSP level 2 browsers; `frameguard` below covers the older ones.
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
      },
    },
    // One year, subdomains included. Browsers only honour HSTS on an HTTPS
    // response, so this is inert on a plain-HTTP deployment and takes effect
    // once the service is reached through TLS.
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: false,
    },
    // X-Frame-Options: DENY, the pre-CSP-2 half of the pair above.
    frameguard: { action: 'deny' },
    // X-Content-Type-Options: nosniff is on by default in Helmet — it is what
    // keeps a browser from sniffing a JSON body as script — and
    // test/api-security-headers.test.ts pins it.
  })

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

  const authFailureTracker = opts.authFailureTracker ?? new AuthFailureTracker()

  // Issue #182: register shutdown hook to clean up nonce store timers on close
  app.addHook('onClose', async () => {
    await nonceStore.shutdown()
    await closeRedis()
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

  // ── Tracing (issue #530) ──
  // One span per request, created after routing so it can be named by the
  // route pattern (not the concrete URL). No-op when OTEL_ENABLED is off:
  // both hooks return before allocating anything.
  app.addHook('preValidation', async (req) => {
    if (!isTelemetryEnabled()) return
    const route = req.routeOptions?.url ?? req.url
    const span = getTracer().startSpan(`HTTP ${req.method} ${route}`, {
      attributes: {
        'http.request.method': req.method,
        'http.route': route,
      },
    })
    setRequestSpan(req, span)
  })

  app.addHook('onError', async (req, _reply, error) => {
    const span = requestSpan(req)
    if (!span) return
    span.recordException(error)
    span.setStatus('ERROR', error.message)
  })

  app.addHook('onResponse', async (req, reply) => {
    const span = requestSpan(req)
    if (!span) return
    span.setAttribute('http.response.status_code', reply.statusCode)
    span.setStatus(reply.statusCode >= 500 ? 'ERROR' : 'OK')
    span.end()
    clearRequestSpan(req)
  })

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
    allowList: (req: { url: string }) => {
      // Issue #353: compare against the path only, ignoring any query string.
      // req.url === '/metrics' would miss '/metrics?x=1', leaving it rate-limited
      // while '/metrics' itself is exempt — an asymmetry that invites bypass.
      const path = req.url.split('?')[0]
      return path === '/health' || path === '/health/dependencies' || path === '/ready' || path === '/version'
    },
  })

  // ── Routes (including /api/stream — issue #158) ──
  await app.register(registerRoutes, { prefix: '/api', nonceStore, authFailureTracker })

  // ── Liveness probe (issue #2, #403) — no DB round trip ──
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: 'Always 200 if the process is up — deliberately does no database round trip. Use /ready to check database and indexer freshness.',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok'] },
              contracts: {
                type: ['array', 'null'],
                items: { type: 'string' },
                description: 'All configured Soroban contract ids (from CONTRACT_IDS or CONTRACT_ID), or null if neither is set.',
              },
              auth: {
                type: 'object',
                properties: {
                  challengesIssued: { type: 'integer' },
                  verificationsSucceeded: { type: 'integer' },
                  verificationsFailed: {
                    type: 'object',
                    properties: {
                      missingHeaders: { type: 'integer' },
                      invalidNonce: { type: 'integer' },
                      invalidSignature: { type: 'integer' },
                      addressMismatch: { type: 'integer' },
                      malformedEncoding: { type: 'integer' },
                      unsupportedAddressType: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      // Issue #375: report all configured contracts as an array.
      const contracts =
        config.stellar.contractIds.length > 0
          ? config.stellar.contractIds
          : config.stellar.contractId
            ? [config.stellar.contractId]
            : null
      return { status: 'ok', contracts, auth: getAuthStats() }
    }
  )

  // ── Dependency health indicators (issue #276) ──
  // Separate from `/health` (liveness — deliberately no DB round trip) and
  // `/ready` (a binary pass/fail probe for orchestrators). This endpoint is
  // for dashboards/alerting: it reports Postgres and Soroban RPC status
  // individually rather than collapsing them into one ready/not-ready bit,
  // so an operator can tell which dependency is degraded at a glance. Always
  // returns 200 — a dependency being down is reported in its own `status`
  // field, not via the HTTP status code.
  const dependencyStatusSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
      latencyMs: { type: 'integer' },
      error: { type: 'string', description: 'Present only when status is "error".' },
    },
  } as const

  app.get(
    '/health/dependencies',
    {
      schema: {
        tags: ['health'],
        summary: 'Per-dependency health indicators',
        description: 'Always 200 — a degraded dependency is reported in its own status field, not the HTTP status code. For dashboards/alerting; use /ready for the orchestrator pass/fail probe.',
        response: {
          200: {
            type: 'object',
            properties: {
              postgres: dependencyStatusSchema,
              rpc: dependencyStatusSchema,
            },
          },
        },
      },
    },
    async () => {
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
            const health = (await Promise.race([rpcServer.getHealth(), timeout(config.http.readyCheckTimeoutMs)])) as { status: string }
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
    }
  )

  // ── Prometheus metrics (issue #274, #353) ─────────────────────────────────
  // Issue #353: /metrics was in the rate-limit allowList alongside /health and
  // /ready, making it exempt from throttling and publicly accessible with no
  // credential. Two changes here:
  //   1. /metrics is removed from the allowList (it now counts against the
  //      shared per-IP limit).
  //   2. When METRICS_TOKEN is set, the endpoint requires
  //      "Authorization: Bearer <token>". A missing or wrong token returns 401.
  //      Operators who run Prometheus on a trusted internal network and do not
  //      set METRICS_TOKEN get the same open behaviour as before, while those
  //      who expose the port publicly can opt in to token protection.
  //
  // Note: the duplicate bare `app.get('/metrics', …)` that existed above this
  // block (using the `register` alias) has been removed; both references now
  // point at `metricsRegistry`, which is the same object.

  app.get(
    '/version',
    {
      schema: {
        tags: ['health'],
        summary: 'Build metadata',
        response: {
          200: {
            type: 'object',
            properties: {
              version: { type: 'string', description: "package.json's version, or 'unknown' if it couldn't be read." },
              commit: { type: 'string', description: "SOURCE_COMMIT env var, or 'unknown' if unset." },
              buildDate: { type: 'string', description: "BUILD_DATE env var, or 'unknown' if unset." },
            },
          },
        },
      },
    },
    async () => ({
      version: packageVersionResult.version,
      commit: process.env.SOURCE_COMMIT ?? 'unknown',
      buildDate: process.env.BUILD_DATE ?? 'unknown',
    })
  )

  // ── Prometheus metrics (issue #274, #353) — SSE connection count + message throughput ──
  // Issue #353: when METRICS_TOKEN is set in env, require "Authorization: Bearer <token>".
  // Callers without a token (or with the wrong one) get 401. Operators on a trusted
  // internal network who do not set METRICS_TOKEN get the same open behaviour as before.
  app.get(
    '/metrics',
    {
      schema: {
        tags: ['stats'],
        summary: 'Prometheus scrape endpoint',
        description:
          'Prometheus exposition format (text/plain). Exposes ourdao_sse_connections (gauge: currently open SSE connections), ' +
          'ourdao_sse_connections_total (counter: SSE connections opened, ever), ourdao_sse_messages_total (counter: SSE messages ' +
          'written, labeled by event_type), plus Node.js default process/runtime metrics from prom-client. ' +
          'When METRICS_TOKEN is set, requires "Authorization: Bearer <token>".',
        response: {
          200: {
            content: {
              'text/plain': {
                schema: { type: 'string' },
              },
            },
          },
          401: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const metricsToken = config.http.metricsToken
      if (metricsToken) {
        const authHeader = req.headers.authorization ?? ''
        if (authHeader !== `Bearer ${metricsToken}`) {
          return reply.code(401).send({ error: 'Unauthorized' })
        }
      }
      reply.header('Content-Type', metricsRegistry.contentType)
      return metricsRegistry.metrics()
    }
  )

  // ── Readiness probe (issue #2) — checks DB + indexer freshness ──
  app.get(
    '/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description:
          "Checks Postgres reachability and indexer freshness. 200 means ready (indexer 'cold_start' on an empty " +
          "database is still 200 — see acceptance criteria). 503 covers every not-ready reason: postgres_timeout, " +
          'postgres_unreachable, postgres_error, reorg_detected, indexer_stale.',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ready'] },
              indexer: { type: 'string', enum: ['cold_start', 'ok'] },
              lastIndexedLedger: { type: ['integer', 'null'] },
              observedTipLedger: { type: ['integer', 'null'] },
              ledgersBehind: { type: ['integer', 'null'] },
              estimatedLagSeconds: { type: ['integer', 'null'] },
              secondsSinceUpdate: { type: ['integer', 'null'] },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['not ready'] },
              reason: {
                type: 'string',
                enum: ['postgres_timeout', 'postgres_unreachable', 'postgres_error', 'reorg_detected', 'indexer_stale'],
              },
              reorg: {
                type: 'object',
                description: 'Present only when reason is reorg_detected.',
                properties: {
                  detectedAt: { type: 'string' },
                  contractId: { type: 'string' },
                  lastLedger: { type: ['integer', 'null'] },
                  detail: { type: 'string' },
                },
              },
              lastIndexedLedger: { type: ['integer', 'null'], description: 'Present when reason is reorg_detected or indexer_stale.' },
              observedTipLedger: { type: ['integer', 'null'], description: 'Present when reason is reorg_detected or indexer_stale.' },
              ledgersBehind: { type: ['integer', 'null'], description: 'Present only when reason is indexer_stale.' },
              estimatedLagSeconds: { type: ['integer', 'null'], description: 'Present only when reason is indexer_stale.' },
              secondsSinceUpdate: { type: 'integer', description: 'Present only when reason is indexer_stale.' },
              staleAfterMs: { type: 'integer', description: 'Present only when reason is indexer_stale.' },
            },
          },
        },
      },
    },
    async (req, reply) => {
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
    // Issue #375: when CONTRACT_IDS is configured, verify every configured
    // contract has a cursor row before checking freshness. A missing row means
    // that contract has never been polled — treat the whole probe as cold_start.
    let row: CursorRow | null = null
    const configuredIds = config.stellar.contractIds
    if (configuredIds.length > 0) {
      // Multi-contract path: fetch all configured contracts' cursor rows.
      let rows: CursorRow[] = []
      try {
        rows = await pool
          .query<CursorRow>(
            `SELECT last_ledger, observed_tip_ledger, updated_at
             FROM indexer_cursor
             WHERE contract_id = ANY($1::text[])`,
            [configuredIds]
          )
          .then((r) => r.rows)
      } catch (err) {
        if (!isUndefinedTable(err)) {
          req.log.error({ err }, '/ready: indexer cursor query failed')
          return reply.code(503).send({ status: 'not ready', reason: 'postgres_error' })
        }
        // Table may not exist yet — treat as cold start
      }
      // Any configured contract with no row has never been polled.
      if (rows.length < configuredIds.length) {
        return reply.code(200).send({
          status: 'ready',
          indexer: 'cold_start',
          lastIndexedLedger: null,
          observedTipLedger: null,
          ledgersBehind: null,
          estimatedLagSeconds: null,
          secondsSinceUpdate: null,
        })
      }
      // Pick the least-advanced (oldest updated_at) row as the worst case.
      row = rows.reduce((worst, r) => {
        if (worst === null) return r
        if (r.updated_at === null) return r
        if (worst.updated_at === null) return worst
        return new Date(r.updated_at) < new Date(worst.updated_at) ? r : worst
      }, null as CursorRow | null)
    } else {
      // Generic path: use the worst (oldest) cursor row across all contracts.
      // Issue #289: indexer_cursor now has one row per tailed contract instead
      // of a single id=1 row. Freshness/readiness reflects the *worst*
      // (least recently updated) contract.
      try {
        row = await pool
          .query<CursorRow>('SELECT last_ledger, observed_tip_ledger, updated_at FROM indexer_cursor ORDER BY updated_at ASC NULLS FIRST LIMIT 1')
          .then((r) => r.rows[0] ?? null)
      } catch (err) {
        // Issue #347: a failing cursor read is not a cold start unless the table
        // is genuinely missing — otherwise the orchestrator routes traffic to an
        // instance whose indexer state is unknown.
        if (!isUndefinedTable(err)) {
          req.log.error({ err }, '/ready: indexer cursor query failed')
          return reply.code(503).send({ status: 'not ready', reason: 'postgres_error' })
        }
        // Table may not exist yet — treat as cold start
      }
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
    } catch (err) {
      // Issue #347: a failing halt read could hide a recorded reorg, which is
      // exactly what this endpoint exists to report — so only a missing table
      // (a database that predates migration 0030) is tolerated.
      if (!isUndefinedTable(err)) {
        req.log.error({ err }, '/ready: reorg halt query failed')
        return reply.code(503).send({ status: 'not ready', reason: 'postgres_error' })
      }
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
    const estimatedLagSeconds = ledgersBehind != null ? ledgersBehind * config.stellar.ledgerCloseTimeSeconds : null

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

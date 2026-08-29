import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import etag from '@fastify/etag'
import { config } from '../config.js'
import { pool } from '../db/index.js'
import { registerRoutes } from './routes/index.js'
import { registerStreamEndpoint } from './stream.js'
import { MemoryNonceStore, PostgresNonceStore, type NonceStore } from '../auth.js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

interface CursorRow {
  last_ledger: number | null
  observed_tip_ledger: number | null
  updated_at: string | null
}

interface PackageJson {
  version: string
}

// Helper to read package.json version
function readPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(__dirname, '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson
    return pkg.version
  } catch {
    return 'unknown'
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.http.logLevel },
    trustProxy: config.http.trustProxy === 'true',
  })

  // Select nonce store implementation based on config (issue #66)
  let nonceStore: NonceStore
  if (config.db.nonceStore === 'postgres') {
    nonceStore = new PostgresNonceStore(pool)
  } else {
    nonceStore = new MemoryNonceStore()
  }

  await app.register(etag)

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
    allowList: (req: { url: string }) => req.url === '/health' || req.url === '/ready' || req.url === '/version',
  })

  // ── Routes ──
  await app.register(registerRoutes, { prefix: '/api', nonceStore })

  // ── Stream endpoint (issue #63) ──
  await registerStreamEndpoint(app, pool)

  // ── Liveness probe (issue #2) — no DB round trip ──
  app.get('/health', async () => ({ status: 'ok', contract: config.stellar.contractId || null }))

  // ── Version endpoint (issue #64) — build metadata ──
  app.get('/version', async () => ({
    version: readPackageVersion(),
    commit: process.env.SOURCE_COMMIT ?? 'unknown',
    buildDate: process.env.BUILD_DATE ?? 'unknown',
  }))

  // ── Readiness probe (issue #2) — checks DB + indexer freshness ──
  app.get('/ready', async (_req, reply) => {
    // 1. Postgres reachable?
    try {
      await pool.query('SELECT 1')
    } catch {
      return reply.code(503).send({ status: 'not ready', reason: 'postgres_unreachable' })
    }

    // 2. Indexer cursor state
    let row: CursorRow | null = null
    try {
      row = await pool
        .query<CursorRow>('SELECT last_ledger, observed_tip_ledger, updated_at FROM indexer_cursor WHERE id = 1')
        .then((r) => r.rows[0] ?? null)
    } catch {
      // Table may not exist yet — treat as cold start
    }

    if (!row || row.last_ledger === null) {
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

    const updatedAt = new Date(row.updated_at!).getTime()
    const secondsSinceUpdate = Math.floor((Date.now() - updatedAt) / 1000)
    const isStale = Date.now() - updatedAt > config.indexer.staleAfterMs
    const lastLedger = row.last_ledger
    const tipLedger = row.observed_tip_ledger
    const ledgersBehind = lastLedger != null && tipLedger != null && tipLedger > lastLedger
      ? tipLedger - lastLedger
      : null
    const estimatedLagSeconds = ledgersBehind != null ? ledgersBehind * 5 : null

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

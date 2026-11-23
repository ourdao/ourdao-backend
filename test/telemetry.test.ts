import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { initTelemetry, type SpanRecord } from '../src/telemetry.js'
import { closeDb, resetDb } from './db.js'

// Issue #530 — the API process now emits one span per request (plus child
// spans for the heaviest handlers), instead of only the indexer path being
// traced. Traces are opt-in: with OTEL_ENABLED off the tracer is a no-op.

describe('API request tracing (issue #530)', () => {
  let app: FastifyInstance
  let records: SpanRecord[]

  beforeEach(async () => {
    await resetDb()
    records = []
    initTelemetry({ enabled: true, onSpanEnd: (r) => records.push(r) })
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  afterAll(async () => {
    initTelemetry({ enabled: false })
    await closeDb()
  })

  it('creates one span per request, named by route, with method/route/status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members' })
    expect(res.statusCode).toBe(200)

    const requestSpan = records.find((r) => r.name === 'HTTP GET /api/members')
    expect(requestSpan).toBeDefined()
    expect(requestSpan!.attributes['http.request.method']).toBe('GET')
    expect(requestSpan!.attributes['http.route']).toBe('/api/members')
    expect(requestSpan!.attributes['http.response.status_code']).toBe(200)
    expect(requestSpan!.statusCode).toBe('OK')
  })

  it('adds a child span around the heavy /api/members/:address/summary query', async () => {
    // Any valid ed25519 public key: the route 404s at the DB layer, but the
    // summary query span is created and ends either way.
    const address = Keypair.random().publicKey()
    const res = await app.inject({ method: 'GET', url: `/api/members/${address}/summary` })
    expect(res.statusCode).toBe(404)

    const requestSpan = records.find((r) => r.name === `HTTP GET /api/members/:address/summary`)
    const querySpan = records.find((r) => r.name === 'members.summary')
    expect(requestSpan).toBeDefined()
    expect(querySpan).toBeDefined()
    expect(querySpan!.parentSpanId).toBe(requestSpan!.spanId)
    expect(querySpan!.traceId).toBe(requestSpan!.traceId)
    expect(querySpan!.attributes['db.system']).toBe('postgresql')
  })

  it('adds a child span around the /api/stats aggregate query', async () => {
    await query(
      `INSERT INTO members (address, joined_ledger, exited) VALUES ('GA', 10, false)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)

    const requestSpan = records.find((r) => r.name === 'HTTP GET /api/stats')
    const statsSpan = records.find((r) => r.name === 'stats.aggregate')
    expect(requestSpan).toBeDefined()
    expect(statsSpan).toBeDefined()
    expect(statsSpan!.parentSpanId).toBe(requestSpan!.spanId)
    expect(statsSpan!.attributes['db.system']).toBe('postgresql')
  })

  it('records an error span when the response is a 5xx', async () => {
    // /ready returns 503 while the indexer cursor is absent (cold start is
    // 200, so make the cursor present but stale).
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger, updated_at)
       VALUES (1, 10, now() - interval '1 hour')`
    )
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)

    const requestSpan = records.find((r) => r.name === 'HTTP GET /ready')
    expect(requestSpan).toBeDefined()
    expect(requestSpan!.attributes['http.response.status_code']).toBe(503)
    expect(requestSpan!.statusCode).toBe('ERROR')
  })

  it('registers no spans at all when OTEL_ENABLED is off', async () => {
    await app.close()
    records = []
    initTelemetry({ enabled: false, onSpanEnd: (r) => records.push(r) })
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/members' })
    expect(res.statusCode).toBe(200)
    expect(records).toEqual([])
  })
})

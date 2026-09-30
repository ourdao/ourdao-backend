import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #191: a recorded ledger discontinuity is visible over the API —
// `/ready` reports it as its own reason, distinct from `indexer_stale`, and
// `/api/stats` carries it for dashboards — until an operator clears it.

async function recordHalt(detail = 'ledger 500 hash changed', contract = 'CTEST'): Promise<void> {
  await query(
    `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail) VALUES ($1, 500, 'HASH_500', $2)`,
    [contract, detail]
  )
}

describe('reorg halt surfaced on /ready and /api/stats (issue #191)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('/ready reports reorg_detected with the halt details, even though the cursor is fresh', async () => {
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, observed_tip_ledger, updated_at) VALUES ('CTEST', 500, 600, now())`)
    await recordHalt()

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.status).toBe('not ready')
    expect(body.reason).toBe('reorg_detected')
    expect(body.reorg).toMatchObject({ contractId: 'CTEST', lastLedger: 500, detail: 'ledger 500 hash changed' })
    expect(new Date(body.reorg.detectedAt).getTime()).toBeGreaterThan(0)
    expect(body.lastIndexedLedger).toBe(500)
    expect(body.observedTipLedger).toBe(600)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('/ready distinguishes a halt from ordinary staleness and from a cold start', async () => {
    // Stale cursor alone: indexer_stale.
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, updated_at) VALUES ('CTEST', 500, now() - interval '3 minutes')`)
    let res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.json().reason).toBe('indexer_stale')

    // Stale cursor plus a recorded halt: the halt wins — restarting the
    // worker is the wrong response, so the probe must not say "stale".
    await recordHalt()
    res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toBe('reorg_detected')

    // No cursor at all but a halt on record: still not ready.
    await query('DELETE FROM indexer_cursor')
    res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toBe('reorg_detected')
    expect(res.json().lastIndexedLedger).toBeNull()
  })

  it('/ready recovers once the halt is cleared, and only the latest uncleared halt is reported', async () => {
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, updated_at) VALUES ('CTEST', 500, now())`)
    await recordHalt('older halt')
    await query(`UPDATE reorg_halts SET cleared_at = now(), cleared_by = 'reindex'`)
    let res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json().indexer).toBe('ok')

    await recordHalt('newer halt')
    res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.json().reorg.detail).toBe('newer halt')
  })

  it('/api/stats carries the halt for dashboards and drops it when cleared', async () => {
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, updated_at) VALUES ('CTEST', 500, now())`)

    let res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json().reorgDetected).toBe(false)
    expect(res.json().reorgHalt).toBeNull()
    expect(res.json().indexerStale).toBe(false)

    await recordHalt('same-height fork at 500', 'CTEST')
    // The stats payload is cached per process for STATS_CACHE_MS; a fresh
    // server sees the new row.
    app = await buildServer()
    await app.ready()
    res = await app.inject({ method: 'GET', url: '/api/stats' })
    const body = res.json()
    expect(body.reorgDetected).toBe(true)
    expect(body.reorgHalt).toMatchObject({ contractId: 'CTEST', lastLedger: 500, detail: 'same-height fork at 500' })
    expect(typeof body.reorgHalt.detectedAt).toBe('string')
    // Staleness is reported independently: the cursor is fresh here.
    expect(body.indexerStale).toBe(false)

    await query(`UPDATE reorg_halts SET cleared_at = now(), cleared_by = 'operator'`)
    app = await buildServer()
    await app.ready()
    res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.json().reorgDetected).toBe(false)
    expect(res.json().reorgHalt).toBeNull()
  })
})

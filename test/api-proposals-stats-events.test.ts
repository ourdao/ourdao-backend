import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { config } from '../src/config.js'
import { pool, query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: proposals, stats, events, admin/log', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/proposals/loan returns newest first', async () => {
    await query(
      `INSERT INTO loan_proposals (id, borrower, amount) VALUES (1, 'GA', 100), (2, 'GA', 200)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/proposals/loan' })
    const body = res.json()
    expect(body.map((p: { id: number }) => p.id)).toEqual([2, 1])
    expect(body[0].tallies_weighted).toBe(false)
  })

  it('GET /api/proposals/treasury returns newest first', async () => {
    await query(
      `INSERT INTO treasury_proposals (id, amount, destination) VALUES (1, 100, 'GD'), (2, 200, 'GD')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury' })
    const body = res.json()
    expect(body.map((p: { id: number }) => p.id)).toEqual([2, 1])
    expect(body[0].tallies_weighted).toBe(false)
  })

  it('GET /api/stats aggregates across all domain tables', async () => {
    // GA: active member with stake. GB: exited — a stale stake value that
    // should be excluded from totalStaked (issue #13). GPHANTOM: a row with
    // no join event (e.g. from name_reg) that must count for nothing (#14).
    await query(
      `INSERT INTO members (address, joined_ledger, exited, stake) VALUES
       ('GA', 10, false, 100), ('GB', 20, true, 50), ('GPHANTOM', NULL, false, 0)`
    )
    await query(`INSERT INTO loan_proposals (id, borrower, amount) VALUES (1, 'GA', 100)`)
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (1, 'GA', 100, 100, 'active'), (2, 'GA', 50, 0, 'repaid'), (3, 'GA', 80, 88, 'defaulted')`
    )
    await query(`INSERT INTO treasury_proposals (id, amount, destination) VALUES (1, 500, 'GD')`)
    await query(
      `INSERT INTO indexer_cursor (id, last_ledger) VALUES (1, 999)
       ON CONFLICT (id) DO UPDATE SET last_ledger = 999`
    )

    await query(
      `UPDATE dao_totals SET interest_collected = 4200, principal_lent = 9000,
              principal_repaid = 3000, value_defaulted = 88 WHERE id = 1`
    )
    await query(`UPDATE indexer_cursor SET observed_tip_ledger = 1200 WHERE id = 1`)
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('999-0', 'loan_dflt', 999, 'boom')`
    )

    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    const body = res.json()
    // totalMembers is all-time (GA + GB), activeMembers is current (GA only) —
    // they must differ, matching the contract's two getters. GPHANTOM counts
    // for neither.
    expect(body.totalMembers).toBe(2)
    expect(body.activeMembers).toBe(1)
    expect(body.totalLoans).toBe(3)
    expect(body.activeLoans).toBe(1)
    expect(body.defaultedLoans).toBe(1)
    expect(body.totalDefaultedValue).toBe('88')
    expect(body.totalLoanProposals).toBe(1)
    expect(body.totalTreasuryProposals).toBe(1)
    // Only GA's stake — GB exited, so their stale 50 is excluded.
    expect(body.totalStaked).toBe('100')
    expect(body.lastIndexedLedger).toBe(999)
    // Issue #45: the folded high-water mark and the RPC-observed tip are
    // reported separately rather than conflated into one column.
    expect(body.observedTipLedger).toBe(1200)
    // Issue #139: derived from the configured ledger close time, not a bare literal.
    expect(body.estimatedLagSeconds).toBe((1200 - 999) * config.stellar.ledgerCloseTimeSeconds)
    // Issue #43: a dashboard-visible count of quarantined events.
    expect(body.quarantinedEvents).toBe(1)
    // Lifetime money figures (issue #24), decimal strings.
    expect(body.interestCollected).toBe('4200')
    expect(body.principalLent).toBe('9000')
    expect(body.principalRepaid).toBe('3000')
    expect(body.valueDefaulted).toBe('88')
    // Issue #156: live SSE connection count is part of the stats payload.
    expect(typeof body.connectedStreams).toBe('number')
    expect(body.connectedStreams).toBeGreaterThanOrEqual(0)
  })

  it('GET /api/stats is cached: a burst of calls issues one set of queries (issue #18)', async () => {
    await query(`INSERT INTO indexer_cursor (id, last_ledger) VALUES (1, 5) ON CONFLICT (id) DO UPDATE SET last_ledger = 5`)
    const spy = vi.spyOn(pool, 'query')
    try {
      const first = await app.inject({ method: 'GET', url: '/api/stats' })
      const callsAfterFirst = spy.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)
      expect(first.headers['cache-control']).toMatch(/max-age=/)

      const second = await app.inject({ method: 'GET', url: '/api/stats' })
      const third = await app.inject({ method: 'GET', url: '/api/stats' })
      // No new DB queries for the cached responses.
      expect(spy.mock.calls.length).toBe(callsAfterFirst)
      expect(second.json()).toEqual(first.json())
      expect(third.json()).toEqual(first.json())
    } finally {
      spy.mockRestore()
    }
  })

  it('serves the last stats value when an expired-cache recompute fails', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(initial.statusCode).toBe(200)

    const realNow = Date.now
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow() + config.http.statsCacheMs + 1)
    const queryFailure = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database unavailable'))
    try {
      const stale = await app.inject({ method: 'GET', url: '/api/stats' })
      expect(stale.statusCode).toBe(200)
      expect(stale.headers['x-data-stale']).toBe('true')
      expect(stale.json()).toEqual(initial.json())
    } finally {
      clock.mockRestore()
      queryFailure.mockRestore()
    }
  })

  it('sheds a blocked stats recompute while an ordinary read still succeeds', async () => {
    // This is deliberately a real Postgres test. An ACCESS EXCLUSIVE lock
    // makes the aggregate wait on `members`; while it occupies the one stats
    // slot, another stats request must receive 503, yet `/loans` (a cheap
    // query on a different table) still obtains a pool connection and works.
    const locker = await pool.connect()
    let firstStats: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE members IN ACCESS EXCLUSIVE MODE')
      firstStats = app.inject({ method: 'GET', url: '/api/stats' })

      const deadline = Date.now() + 2_000
      let statsQueryIsBlocked = false
      while (Date.now() < deadline) {
        const waiting = await pool.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND query LIKE '%AS total_members%'
              AND wait_event_type = 'Lock'`
        )
        if (waiting.rows.length > 0) {
          statsQueryIsBlocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(statsQueryIsBlocked).toBe(true)

      const shed = await app.inject({ method: 'GET', url: '/api/stats' })
      expect(shed.statusCode).toBe(503)
      expect(shed.headers['retry-after']).toBe(String(config.http.statsRetryAfterSeconds))

      const cheapRead = await app.inject({ method: 'GET', url: '/api/loans' })
      expect(cheapRead.statusCode).toBe(200)
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
      await firstStats
    }
  })

  it('GET /api/events filters by symbol and paginates with before=<ledger>', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
       ('1-0', 10, now(), 'C1', 'joined', '[]', '[]'),
       ('2-0', 20, now(), 'C1', 'staked', '[]', '[]'),
       ('3-0', 30, now(), 'C1', 'joined', '[]', '[]')`
    )
    const bySymbol = await app.inject({ method: 'GET', url: '/api/events?symbol=joined' })
    expect(bySymbol.json().events).toHaveLength(2)

    const paged = await app.inject({ method: 'GET', url: '/api/events?before=30' })
    const pagedBody = paged.json().events
    expect(pagedBody).toHaveLength(2)
    expect(pagedBody.every((e: { ledger: number }) => e.ledger < 30)).toBe(true)
  })

  it('GET /api/events?contract= scopes the raw log to one deployment (issue #16)', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
       ('a-0', 10, now(), 'COLD', 'joined', '[]', '[]'),
       ('b-0', 20, now(), 'CNEW', 'joined', '[]', '[]'),
       ('c-0', 30, now(), 'CNEW', 'staked', '[]', '[]')`
    )
    const scoped = await app.inject({ method: 'GET', url: '/api/events?contract=CNEW' })
    const body = scoped.json().events
    expect(body).toHaveLength(2)
    expect(body.every((e: { contract_id: string }) => e.contract_id === 'CNEW')).toBe(true)
  })

  it('GET /api/admin/log only returns admin/governance symbols, newest first', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
       ('1-0', 10, now(), 'C1', 'joined', '[]', '[]'),
       ('2-0', 20, now(), 'C1', 'paused', '[]', '[]'),
       ('3-0', 30, now(), 'C1', 'threshold', '[]', '[]')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/admin/log' })
    const body = res.json()
    expect(body.map((e: { symbol: string }) => e.symbol)).toEqual(['threshold', 'paused'])
  })

  it('GET /api/interest returns the distribution history, newest first, with a before-ledger cursor (issue #24)', async () => {
    await query(
      `INSERT INTO interest_distributions (event_id, ledger, amount, active_members) VALUES
       ('i1', 10, 100, 2), ('i2', 20, 250, 5), ('i3', 30, 90, 3)`
    )
    const all = await app.inject({ method: 'GET', url: '/api/interest' })
    expect(all.json().map((d: { ledger: number }) => d.ledger)).toEqual([30, 20, 10])

    const paged = await app.inject({ method: 'GET', url: '/api/interest?before=30' })
    const body = paged.json()
    expect(body).toHaveLength(2)
    expect(body.every((d: { ledger: number }) => d.ledger < 30)).toBe(true)
    expect(body[0].amount).toBe('250')
  })
})

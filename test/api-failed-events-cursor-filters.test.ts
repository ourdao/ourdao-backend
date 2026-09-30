import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #192: every quarantine record is reachable through the API. The feed
// pages with `?before=<id>` like the other historical feeds, filters by
// symbol and ledger range, and reports the filtered total in X-Total-Count so
// an operator sees the scale without paging.

async function seedFailures(count: number, opts: { symbol?: (i: number) => string; ledger?: (i: number) => number } = {}): Promise<void> {
  const rows: string[] = []
  const params: unknown[] = []
  for (let i = 1; i <= count; i++) {
    params.push(`ev-${i}`, opts.symbol ? opts.symbol(i) : 'loan_dflt', opts.ledger ? opts.ledger(i) : 1000 + i, `boom ${i}`)
    const b = params.length
    rows.push(`($${b - 3}, $${b - 2}, $${b - 1}, $${b})`)
  }
  await query(`INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ${rows.join(', ')}`, params)
}

describe('GET /api/admin/failed-events paging and filters (issue #192)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('pages past the 200-row cap with ?before= until the oldest record is reached', async () => {
    await seedFailures(205)

    const first = await app.inject({ method: 'GET', url: '/api/admin/failed-events?limit=200' })
    expect(first.statusCode).toBe(200)
    const page1 = first.json() as Array<{ id: number }>
    expect(page1).toHaveLength(200)
    expect(first.headers['x-total-count']).toBe('205')

    const last = page1[page1.length - 1]!.id
    const second = await app.inject({ method: 'GET', url: `/api/admin/failed-events?limit=200&before=${last}` })
    const page2 = second.json() as Array<{ id: number; event_id: string }>
    expect(page2).toHaveLength(5)
    expect(page2.every((r) => r.id < last)).toBe(true)
    // The very first failure, the informative one, is the last row of the last page.
    expect(page2[page2.length - 1]!.event_id).toBe('ev-1')
    // The total is the filtered set, not the page, so it does not shrink as
    // the cursor advances.
    expect(second.headers['x-total-count']).toBe('205')

    const seen = new Set([...page1, ...page2].map((r) => r.id))
    expect(seen.size).toBe(205)
  })

  it('filters by symbol and reports the filtered total', async () => {
    await seedFailures(6, { symbol: (i) => (i % 2 === 0 ? 'loan_vote' : 'loan_dflt') })
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events?symbol=loan_vote' })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ symbol: string }>
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.symbol === 'loan_vote')).toBe(true)
    expect(res.headers['x-total-count']).toBe('3')
  })

  it('filters by an inclusive ledger range using the shared validation helpers', async () => {
    await seedFailures(10, { ledger: (i) => 100 * i })
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events?from_ledger=300&to_ledger=500' })
    expect(res.statusCode).toBe(200)
    const ledgers = (res.json() as Array<{ ledger: number }>).map((r) => r.ledger)
    expect(ledgers).toEqual([500, 400, 300])
    expect(res.headers['x-total-count']).toBe('3')

    const openEnded = await app.inject({ method: 'GET', url: '/api/admin/failed-events?from_ledger=900' })
    expect((openEnded.json() as Array<{ ledger: number }>).map((r) => r.ledger)).toEqual([1000, 900])
  })

  it('filters compose with each other, with ?unresolved= and with the cursor', async () => {
    await seedFailures(8, { symbol: (i) => (i <= 4 ? 'joined' : 'exited'), ledger: (i) => 10 * i })
    await query(`UPDATE failed_events SET resolved_at = now() WHERE event_id = 'ev-2'`)

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/failed-events?symbol=joined&from_ledger=10&to_ledger=40&unresolved=true',
    })
    const rows = res.json() as Array<{ id: number; event_id: string }>
    expect(rows.map((r) => r.event_id)).toEqual(['ev-4', 'ev-3', 'ev-1'])
    expect(res.headers['x-total-count']).toBe('3')

    const paged = await app.inject({
      method: 'GET',
      url: `/api/admin/failed-events?symbol=joined&unresolved=true&before=${rows[0]!.id}&limit=1`,
    })
    expect((paged.json() as Array<{ event_id: string }>).map((r) => r.event_id)).toEqual(['ev-3'])
    expect(paged.headers['x-total-count']).toBe('3')
  })

  it('reports a zero total and an empty page when nothing matches', async () => {
    await seedFailures(2)
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events?symbol=nothing_like_this' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    expect(res.headers['x-total-count']).toBe('0')
  })

  it('rejects malformed filters with 400 and the shared messages', async () => {
    const cases: Array<[string, RegExp]> = [
      ['symbol=', /invalid symbol filter/],
      // A repeated parameter arrives as an array; the querystring schema
      // rejects it before the handler runs.
      ['symbol=a&symbol=b', /symbol/],
      ['from_ledger=abc', /invalid ledger range/],
      ['from_ledger=-1', /invalid ledger range/],
      ['from_ledger=500&to_ledger=100', /invalid ledger range/],
      ['from_ledger=0&to_ledger=20000', /invalid ledger range/],
      ['before=notanid', /invalid before cursor/],
      ['limit=0', /invalid limit/],
    ]
    for (const [qs, message] of cases) {
      const res = await app.inject({ method: 'GET', url: `/api/admin/failed-events?${qs}` })
      expect(res.statusCode, qs).toBe(400)
      expect(res.json().error, qs).toMatch(message)
    }
  })

  it('never returns the raw error text and stays no-store', async () => {
    await seedFailures(1)
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events?symbol=loan_dflt' })
    expect(Object.keys(res.json()[0]).sort()).toEqual(
      ['created_at', 'event_id', 'id', 'ledger', 'resolved_at', 'symbol'].sort()
    )
    expect(res.payload).not.toContain('boom')
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

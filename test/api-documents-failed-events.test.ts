import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { Keypair } from '@stellar/stellar-sdk'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: GET /api/documents (issue #44)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('returns a proposal\'s attached documents newest-ledger-first', async () => {
    await query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger)
       VALUES ('1-0', 7, 'loan', 'GA', 100), ('2-0', 7, 'loan', 'GA', 200)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/documents?kind=loan&proposal_id=7' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body[0].ledger).toBe(200)
    expect(body[1].ledger).toBe(100)
  })

  it('never returns the content hash — only existence/history fields', async () => {
    await query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger) VALUES ('1-0', 1, 'loan', 'GA', 100)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/documents?kind=loan&proposal_id=1' })
    const body = res.json()
    expect(Object.keys(body[0]).sort()).toEqual(
      ['attached_at', 'caller', 'id', 'kind', 'ledger', 'proposal_id', 'tx_hash'].sort()
    )
  })

  it('keeps loan and treasury documents with the same numeric id apart', async () => {
    await query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger)
       VALUES ('1-0', 4, 'loan', 'GA', 100), ('2-0', 4, 'treasury', 'GB', 100)`
    )
    const loanRes = await app.inject({ method: 'GET', url: '/api/documents?kind=loan&proposal_id=4' })
    expect(loanRes.json()).toHaveLength(1)
    expect(loanRes.json()[0].caller).toBe('GA')

    const treasuryRes = await app.inject({ method: 'GET', url: '/api/documents?kind=treasury&proposal_id=4' })
    expect(treasuryRes.json()).toHaveLength(1)
    expect(treasuryRes.json()[0].caller).toBe('GB')
  })

  it('rejects a missing or invalid kind before querying', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/documents?proposal_id=1' })
    expect(missing.statusCode).toBe(400)
    const invalid = await app.inject({ method: 'GET', url: '/api/documents?kind=bogus&proposal_id=1' })
    expect(invalid.statusCode).toBe(400)
  })

  it('rejects a non-numeric proposal_id before querying', async () => {
    const invalid = await app.inject({ method: 'GET', url: '/api/documents?kind=loan&proposal_id=abc' })
    expect(invalid.statusCode).toBe(400)
  })
})

describe('API: GET /api/documents listing without a proposal (issue #189)', () => {
  let app: FastifyInstance
  const MEMBER = Keypair.random().publicKey()
  const OTHER = Keypair.random().publicKey()

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    await query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger) VALUES
         ('1-0', 1, 'loan', $1, 100),
         ('2-0', 1, 'treasury', $2, 200),
         ('3-0', 2, 'loan', $1, 300),
         ('4-0', 3, 'treasury', $1, 400)`,
      [MEMBER, OTHER]
    )
  })
  afterAll(closeDb)

  const ledgers = (body: Array<{ ledger: number }>) => body.map((d) => d.ledger)

  it('lists every document newest-ledger-first with no filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(res.statusCode).toBe(200)
    expect(ledgers(res.json())).toEqual([400, 300, 200, 100])
  })

  it('pages the unfiltered listing with ?before= and ?limit=', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/documents?limit=2' })
    expect(ledgers(first.json())).toEqual([400, 300])
    const next = await app.inject({ method: 'GET', url: '/api/documents?limit=2&before=300' })
    expect(ledgers(next.json())).toEqual([200, 100])
    expect(next.headers['cache-control']).toContain('immutable')
  })

  it("filters by caller — a member's attachment history", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/documents?caller=${MEMBER}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(ledgers(body)).toEqual([400, 300, 100])
    expect(body.every((d: { caller: string }) => d.caller === MEMBER)).toBe(true)
  })

  it('combines caller and kind', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/documents?caller=${MEMBER}&kind=loan` })
    expect(ledgers(res.json())).toEqual([300, 100])
  })

  it('filters by kind alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents?kind=treasury' })
    expect(ledgers(res.json())).toEqual([400, 200])
  })

  it('keeps the per-proposal query unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents?kind=loan&proposal_id=1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({ proposal_id: 1, kind: 'loan', caller: MEMBER, ledger: 100 }),
    ])
  })

  it('rejects an invalid caller, and proposal_id without kind', async () => {
    const badCaller = await app.inject({ method: 'GET', url: '/api/documents?caller=not-an-address' })
    expect(badCaller.statusCode).toBe(400)
    expect(badCaller.json()).toMatchObject({ error: 'invalid Stellar address', code: 'BAD_REQUEST' })
    const noKind = await app.inject({ method: 'GET', url: '/api/documents?proposal_id=1' })
    expect(noKind.statusCode).toBe(400)
  })

  it('every query shape is served by its own index', async () => {
    await query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger)
       SELECT 'bulk-' || g, g % 50, CASE WHEN g % 2 = 0 THEN 'loan' ELSE 'treasury' END, 'G' || (g % 200), 1000 + g
         FROM generate_series(1, 5000) g`
    )
    await query('ANALYZE documents')
    const shapes: Array<[string, unknown[], string]> = [
      ['WHERE kind = $1 AND proposal_id = $2', ['loan', 1], 'documents_proposal_idx'],
      ['WHERE caller = $1', [MEMBER], 'documents_caller_idx'],
      ['', [], 'documents_ledger_idx'],
    ]
    for (const [where, params, index] of shapes) {
      const plan = await query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id, proposal_id, kind, caller, ledger, tx_hash, attached_at
           FROM documents ${where} ORDER BY ledger DESC, id DESC LIMIT 50`,
        params
      )
      const text = plan.map((r) => r['QUERY PLAN']).join('\n')
      expect(text, where || 'unfiltered').toContain(index)
      expect(text, where || 'unfiltered').not.toMatch(/Seq Scan/)
    }
  })
})

describe('API: GET /api/admin/failed-events (issue #43)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('returns quarantined events newest first', async () => {
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('1-0', 'loan_dflt', 100, 'boom-1'), ('2-0', 'loan_dflt', 200, 'boom-2')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body[0].event_id).toBe('2-0')
  })

  // Issue #163: `error` holds raw driver/handler exception text — a
  // Postgres error names a constraint, a column and a type; a TypeError
  // carries internal structure. None of that belongs in a response any
  // caller (authenticated or not) can read.
  it('never puts the raw exception text in the response', async () => {
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('1-0', 'loan_dflt', 100, 'duplicate key value violates unique constraint "loans_pkey"')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].error).toBeUndefined()
    expect(res.payload).not.toContain('loans_pkey')
    expect(res.payload).not.toContain('duplicate key')
  })

  it('does not cache the response publicly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/failed-events' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('paginates with a before cursor on id', async () => {
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('1-0', 'loan_dflt', 100, 'boom-1'), ('2-0', 'loan_dflt', 200, 'boom-2')`
    )
    const first = await app.inject({ method: 'GET', url: '/api/admin/failed-events?limit=1' })
    const firstBody = first.json()
    expect(firstBody).toHaveLength(1)
    expect(firstBody[0].event_id).toBe('2-0')

    const second = await app.inject({
      method: 'GET',
      url: `/api/admin/failed-events?limit=1&before=${firstBody[0].id}`,
    })
    const secondBody = second.json()
    expect(secondBody).toHaveLength(1)
    expect(secondBody[0].event_id).toBe('1-0')
  })

  it('the raw events row for a quarantined event is untouched', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('1-0', 100, now(), 'CTEST', 'loan_dflt', '[]', '[]')`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('1-0', 'loan_dflt', 100, 'boom')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/events' })
    const body = res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0].id).toBe('1-0')
  })
})

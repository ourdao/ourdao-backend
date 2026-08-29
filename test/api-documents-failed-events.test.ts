import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
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

  it('rejects a missing or non-numeric proposal_id before querying', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/documents?kind=loan' })
    expect(missing.statusCode).toBe(400)
    const invalid = await app.inject({ method: 'GET', url: '/api/documents?kind=loan&proposal_id=abc' })
    expect(invalid.statusCode).toBe(400)
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
    expect(body[0].error).toBe('boom-2')
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
    expect(res.json().events).toHaveLength(1)
    expect(res.json().events[0].id).toBe('1-0')
  })
})

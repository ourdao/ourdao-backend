import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const ALICE = Keypair.random().publicKey()
const NOBODY = Keypair.random().publicKey()

describe('API: members and loans', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/members returns active members, newest first, and excludes exited ones', async () => {
    await query(
      `INSERT INTO members (address, joined_ledger, contribution, exited) VALUES
       ('GOLD', 100, 10, false), ('GNEW', 200, 20, false), ('GGONE', 300, 30, true)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/members' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.map((m: { address: string }) => m.address)).toEqual(['GNEW', 'GOLD'])
  })

  it('GET /api/members excludes phantom rows with no join event (issue #14)', async () => {
    await query(
      `INSERT INTO members (address, joined_ledger, exited) VALUES
       ('GREAL', 100, false), ('GPHANTOM', NULL, false)`
    )
    const res = await app.inject({ method: 'GET', url: '/api/members' })
    const body = res.json()
    expect(body.map((m: { address: string }) => m.address)).toEqual(['GREAL'])
  })

  it('GET /api/members/:address 404s for an unknown address', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/members/${NOBODY}` })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/members/:address returns the member when present', async () => {
    await query(`INSERT INTO members (address, contribution) VALUES ($1, 500)`, [ALICE])
    const res = await app.inject({ method: 'GET', url: `/api/members/${ALICE}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().contribution).toBe('500')
  })

  it('GET /api/loans filters by borrower', async () => {
    const borrowerA = Keypair.random().publicKey()
    const borrowerB = Keypair.random().publicKey()
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (1, $1, 100, 100, 'active'), (2, $2, 200, 0, 'repaid'), (3, $1, 300, 300, 'active')`,
      [borrowerA, borrowerB]
    )
    const res = await app.inject({ method: 'GET', url: `/api/loans?borrower=${borrowerA}` })
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body.every((l: { borrower: string }) => l.borrower === borrowerA)).toBe(true)
  })

  it('GET /api/loans filters by status and combined with borrower/pagination', async () => {
    const borrowerA = Keypair.random().publicKey()
    const borrowerB = Keypair.random().publicKey()
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (1, $1, 100, 100, 'active'),
       (2, $1, 200, 0, 'repaid'),
       (3, $2, 300, 300, 'active'),
       (4, $1, 400, 400, 'active')`,
      [borrowerA, borrowerB]
    )
    // Filter by single status
    const statusRes = await app.inject({ method: 'GET', url: '/api/loans?status=active' })
    expect(statusRes.statusCode).toBe(200)
    expect(statusRes.json()).toHaveLength(3)

    // Invalid status returns 400
    const invalidRes = await app.inject({ method: 'GET', url: '/api/loans?status=unknown' })
    expect(invalidRes.statusCode).toBe(400)

    // Combined borrower and status
    const combinedRes = await app.inject({ method: 'GET', url: `/api/loans?borrower=${borrowerA}&status=active` })
    expect(combinedRes.statusCode).toBe(200)
    const combinedBody = combinedRes.json()
    expect(combinedBody).toHaveLength(2)
    expect(combinedBody.map((l: { id: number }) => l.id)).toEqual([4, 1])

    // Combined with pagination before cursor
    const paginatedRes = await app.inject({ method: 'GET', url: `/api/loans?borrower=${borrowerA}&status=active&before=4&limit=1` })
    expect(paginatedRes.statusCode).toBe(200)
    expect(paginatedRes.json()).toHaveLength(1)
    expect(paginatedRes.json()[0].id).toBe(1)
  })

  it('GET /api/loans supports before-id cursor pagination', async () => {
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (10, 'GA', 1, 1, 'active'), (11, 'GA', 1, 1, 'active'), (12, 'GA', 1, 1, 'active')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/loans?before=12&limit=1' })
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe(11)
  })

  it('GET /api/loans/:id 404s when missing, 200s with the row when present', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/loans/999' })
    expect(missing.statusCode).toBe(404)

    const missingZero = await app.inject({ method: 'GET', url: '/api/loans/0' })
    expect(missingZero.statusCode).toBe(404)

    await query(`INSERT INTO loans (id, borrower, amount, outstanding) VALUES (0, 'GA0', 50, 50), (1, 'GA', 100, 100)`)
    const foundZero = await app.inject({ method: 'GET', url: '/api/loans/0' })
    expect(foundZero.statusCode).toBe(200)
    expect(foundZero.json().borrower).toBe('GA0')

    const found = await app.inject({ method: 'GET', url: '/api/loans/1' })
    expect(found.statusCode).toBe(200)
    expect(found.json().borrower).toBe('GA')
  })

  it('GET /api/loans/:id exposes the interest charge and repayment progress derived from total_repayment', async () => {
    await query(
      `INSERT INTO loans (id, borrower, amount, total_repayment, outstanding, status) VALUES
       (5, 'GA', 1000, 1080, 1080, 'active')`
    )
    const res = await app.inject({ method: 'GET', url: '/api/loans/5' })
    const body = res.json()
    expect(body.interest_charge).toBe('80')
    expect(body.repaid_amount).toBe('0')

    await query(`UPDATE loans SET outstanding = 380 WHERE id = 5`)
    const afterPartial = (await app.inject({ method: 'GET', url: '/api/loans/5' })).json()
    expect(afterPartial.repaid_amount).toBe('700')
  })
})

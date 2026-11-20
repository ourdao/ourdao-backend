import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const ROUTES = [
  { kind: 'loan', notFound: 'loan proposal not found' },
  { kind: 'treasury', notFound: 'treasury proposal not found' },
] as const

describe('API: GET /proposals/{loan,treasury}/:id (issue #482)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  for (const { kind, notFound } of ROUTES) {
    describe(`/api/proposals/${kind}/:id`, () => {
      it.each(['abc', '0', '-1', '1.5', '1e3'])('returns 400 for invalid id %s', async (id) => {
        const res = await app.inject({ method: 'GET', url: `/api/proposals/${kind}/${id}` })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toMatchObject({ error: 'invalid proposal id', code: 'BAD_REQUEST' })
      })

      it('returns 404 for a well-formed but nonexistent id', async () => {
        const res = await app.inject({ method: 'GET', url: `/api/proposals/${kind}/999` })
        expect(res.statusCode).toBe(404)
        expect(res.json()).toMatchObject({ error: notFound, code: 'NOT_FOUND' })
      })

      it('returns an existing proposal with tallies_weighted: false', async () => {
        const addr = Keypair.random().publicKey()
        if (kind === 'loan') {
          await query(`INSERT INTO loan_proposals (id, borrower, amount) VALUES (7, $1, 100)`, [addr])
        } else {
          await query(`INSERT INTO treasury_proposals (id, destination, amount) VALUES (7, $1, 100)`, [addr])
        }
        const res = await app.inject({ method: 'GET', url: `/api/proposals/${kind}/7` })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.id).toBe(7)
        expect(body.tallies_weighted).toBe(false)

        const list = await app.inject({ method: 'GET', url: `/api/proposals/${kind}` })
        expect(Object.keys(body).sort()).toEqual(Object.keys(list.json()[0]).sort())
      })
    })
  }
})

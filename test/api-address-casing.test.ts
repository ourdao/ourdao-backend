// Issue #263: Stellar StrKey base32 is canonically uppercase, so a client that
// spells an address in lowercase or mixed case names the same account but used
// to be rejected with 400 — or, on the filter routes, silently returned zero
// rows because the stored value is uppercase. These tests pin that every
// address-accepting route treats the three spellings identically, and that an
// invalid key still fails validation before it reaches Postgres.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const ADDRESS = 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3'
const lower = ADDRESS.toLowerCase()
const mixed = ADDRESS.slice(0, 20).toLowerCase() + ADDRESS.slice(20)

describe('API: address casing is normalised (#263)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()

    await query(
      `INSERT INTO members (address, joined_ledger, contribution, stake, exited)
       VALUES ($1, 100, '5000', '1000', false)`,
      [ADDRESS]
    )
  })
  afterAll(closeDb)

  describe('GET /api/members/:address', () => {
    for (const [label, addr] of [
      ['uppercase (canonical)', ADDRESS],
      ['lowercase', lower],
      ['mixed case', mixed],
    ] as const) {
      it(`resolves a ${label} address to the same member`, async () => {
        const res = await app.inject({ method: 'GET', url: `/api/members/${addr}` })
        expect(res.statusCode).toBe(200)
        // The stored value is returned, so the client sees the canonical form.
        expect(res.json().address).toBe(ADDRESS)
      })
    }

    it('still rejects an invalid key with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/members/not-an-address' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'invalid Stellar address' })
    })
  })

  describe('GET /api/members/:address/summary', () => {
    for (const [label, addr] of [
      ['uppercase', ADDRESS],
      ['lowercase', lower],
      ['mixed case', mixed],
    ] as const) {
      it(`returns the summary for a ${label} address`, async () => {
        const res = await app.inject({ method: 'GET', url: `/api/members/${addr}/summary` })
        expect(res.statusCode).toBe(200)
      })
    }

    it('rejects an invalid key with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/members/nope/summary' })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/members/:address/activity', () => {
    beforeEach(async () => {
      // `data` holds the address at a per-symbol offset; for a `staked` event
      // it is the first element, which is what the route matches on.
      await query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
         VALUES ('evt-casing-1', 100, now(), 'CTEST', 'staked', '[]'::jsonb, $1::jsonb)`,
        [JSON.stringify([ADDRESS, '1000', '1000'])]
      )
    })

    for (const [label, addr] of [
      ['uppercase', ADDRESS],
      ['lowercase', lower],
      ['mixed case', mixed],
    ] as const) {
      it(`finds activity for a ${label} address`, async () => {
        const res = await app.inject({ method: 'GET', url: `/api/members/${addr}/activity` })
        expect(res.statusCode).toBe(200)
        expect(res.json().activity).toHaveLength(1)
      })
    }

    it('rejects an invalid key with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/members/zzz/activity' })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('query-parameter filters', () => {
    it('GET /api/notifications accepts a lowercase address', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/notifications?address=${lower}` })
      expect(res.statusCode).toBe(200)
      expect(Array.isArray(res.json())).toBe(true)
    })

    it('GET /api/notifications rejects an invalid address', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/notifications?address=nope' })
      expect(res.statusCode).toBe(400)
    })

    it('GET /api/documents accepts a lowercase caller filter', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/documents?caller=${lower}` })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/documents rejects an invalid caller filter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/documents?caller=nope' })
      expect(res.statusCode).toBe(400)
    })

    it('GET /api/loans accepts a lowercase borrower filter', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/loans?borrower=${lower}` })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/loans rejects an invalid borrower filter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/loans?borrower=nope' })
      expect(res.statusCode).toBe(400)
    })
  })
})

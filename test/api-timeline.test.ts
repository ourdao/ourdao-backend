import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const BORROWER = Keypair.random().publicKey()
const VOTER_A = Keypair.random().publicKey()
const VOTER_B = Keypair.random().publicKey()
const STRANGER = Keypair.random().publicKey()

let seq = 0

/** Insert one raw event row. `data` is the positional tuple the contract
 *  publishes (see EVENT_FIELDS in src/stellar/events.ts). */
async function ev(
  ledger: number,
  symbol: string,
  data: unknown[],
  opts: { contract?: string; tx?: string } = {}
): Promise<void> {
  seq += 1
  await query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8)`,
    [
      `${String(ledger).padStart(10, '0')}-${String(seq).padStart(10, '0')}`,
      ledger,
      1_700_000_000 + ledger,
      opts.contract ?? 'CTEST',
      symbol,
      JSON.stringify([symbol]),
      JSON.stringify(data),
      opts.tx ?? `tx-${ledger}`,
    ]
  )
}

describe('API: per-entity event timelines (issue #26)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    seq = 0
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  describe('GET /api/loans/:id/timeline', () => {
    it('returns a loan\'s full lifecycle in chronological order', async () => {
      // Loan 7: requested, edited up, two votes, approved, repaid.
      await ev(10, 'loan_req', [7, BORROWER, '500', '550'])
      await ev(20, 'loan_edit', [7, BORROWER, '5000', '5500'])
      await ev(30, 'loan_vote', [7, VOTER_A, true, null])
      await ev(40, 'loan_vote', [7, VOTER_B, true, null])
      await ev(50, 'loan_appr', [7, BORROWER, '5000', null])
      await ev(60, 'loan_rpy', [7, BORROWER, '0'])

      const res = await app.inject({ method: 'GET', url: '/api/loans/7/timeline' })
      expect(res.statusCode).toBe(200)
      const { timeline } = res.json()
      expect(timeline.map((e: { symbol: string }) => e.symbol)).toEqual([
        'loan_req',
        'loan_edit',
        'loan_vote',
        'loan_vote',
        'loan_appr',
        'loan_rpy',
      ])
      expect(timeline.map((e: { ledger: number }) => e.ledger)).toEqual([10, 20, 30, 40, 50, 60])
    })

    it('returns decoded named fields, not raw JSONB', async () => {
      await ev(10, 'loan_req', [7, BORROWER, '500', '550'])
      const { timeline } = (await app.inject({ method: 'GET', url: '/api/loans/7/timeline' })).json()
      const entry = timeline[0]
      expect(entry).toMatchObject({
        symbol: 'loan_req',
        ledger: 10,
        tx_hash: 'tx-10',
        fields: { id: 7, borrower: BORROWER, amount: '500', total_repayment: '550' },
      })
      expect(entry.timestamp).toBeTypeOf('string')
      expect(entry).not.toHaveProperty('data')
      expect(entry).not.toHaveProperty('topics')
    })

    it('returns an empty timeline (200, not 404) for an id with no events', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/loans/999/timeline' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ timeline: [] })
    })

    it('does not leak events from other loans', async () => {
      await ev(10, 'loan_req', [7, BORROWER, '500', '550'])
      await ev(11, 'loan_req', [8, BORROWER, '900', '990'])
      await ev(12, 'loan_vote', [8, VOTER_A, true, null])

      const { timeline } = (await app.inject({ method: 'GET', url: '/api/loans/7/timeline' })).json()
      expect(timeline).toHaveLength(1)
      expect(timeline[0].fields.id).toBe(7)
    })

    it('does not leak non-loan events that happen to share the id', async () => {
      // A treasury proposal 7 and a member "joined" event must never appear
      // on loan 7's timeline.
      await ev(10, 'loan_req', [7, BORROWER, '500', '550'])
      await ev(11, 'tre_prop', [7, '1000', STRANGER, false])
      await ev(12, 'joined', [BORROWER, '10'])

      const { timeline } = (await app.inject({ method: 'GET', url: '/api/loans/7/timeline' })).json()
      expect(timeline.map((e: { symbol: string }) => e.symbol)).toEqual(['loan_req'])
    })

    it('400s on a non-numeric id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/loans/abc/timeline' })
      expect(res.statusCode).toBe(400)
    })

    it('accepts valid loan id 0 (issue #379)', async () => {
      await ev(10, 'loan_req', [0, BORROWER, '500', '550'])
      const res = await app.inject({ method: 'GET', url: '/api/loans/0/timeline' })
      expect(res.statusCode).toBe(200)
      const { timeline } = res.json()
      expect(timeline.map((e: { symbol: string }) => e.symbol)).toEqual(['loan_req'])
    })
  })

  describe('GET /api/proposals/treasury/:id/timeline', () => {
    it('returns the treasury lifecycle in order', async () => {
      await ev(10, 'tre_prop', [3, '1000', STRANGER, true])
      await ev(20, 'committed', [3, VOTER_A])
      await ev(30, 'revealed', [3, VOTER_A, true, null])
      await ev(40, 'tre_vote', [3, VOTER_B, true, null])
      await ev(50, 'tre_exec', [3, '1000', STRANGER])

      const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury/3/timeline' })
      expect(res.statusCode).toBe(200)
      const { timeline } = res.json()
      expect(timeline.map((e: { symbol: string }) => e.symbol)).toEqual([
        'tre_prop',
        'committed',
        'revealed',
        'tre_vote',
        'tre_exec',
      ])
    })

    it('does not collide with a loan proposal of the same id', async () => {
      await ev(10, 'loan_req', [3, BORROWER, '500', '550'])
      await ev(20, 'tre_prop', [3, '1000', STRANGER, false])

      const loan = (await app.inject({ method: 'GET', url: '/api/loans/3/timeline' })).json()
      const treasury = (await app.inject({ method: 'GET', url: '/api/proposals/treasury/3/timeline' })).json()
      expect(loan.timeline.map((e: { symbol: string }) => e.symbol)).toEqual(['loan_req'])
      expect(treasury.timeline.map((e: { symbol: string }) => e.symbol)).toEqual(['tre_prop'])
    })

    it('returns an empty timeline (200) for an unknown proposal id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury/42/timeline' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ timeline: [] })
    })

    it('accepts valid treasury proposal id 0 (issue #379)', async () => {
      await ev(10, 'tre_prop', [0, '1000', STRANGER, false])
      const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury/0/timeline' })
      expect(res.statusCode).toBe(200)
      const { timeline } = res.json()
      expect(timeline.map((e: { symbol: string }) => e.symbol)).toEqual(['tre_prop'])
    })
  })

  describe('GET /api/members/:address/activity', () => {
    it('returns every event naming the address, newest first, across entities', async () => {
      await ev(10, 'joined', [VOTER_A, '10'])
      await ev(20, 'loan_vote', [7, VOTER_A, true, null])
      await ev(30, 'staked', [VOTER_A, '5', '5'])
      await ev(40, 'loan_req', [9, BORROWER, '100', '110']) // different address
      await ev(50, 'committed', [3, VOTER_A])

      const res = await app.inject({ method: 'GET', url: `/api/members/${VOTER_A}/activity` })
      expect(res.statusCode).toBe(200)
      const { activity } = res.json()
      expect(activity.map((e: { symbol: string }) => e.symbol)).toEqual([
        'committed',
        'staked',
        'loan_vote',
        'joined',
      ])
    })

    it('excludes another address\'s events', async () => {
      await ev(10, 'loan_vote', [7, VOTER_A, true, null])
      await ev(20, 'loan_vote', [7, VOTER_B, false, null])

      const { activity } = (await app.inject({ method: 'GET', url: `/api/members/${VOTER_B}/activity` })).json()
      expect(activity).toHaveLength(1)
      expect(activity[0].fields.voter).toBe(VOTER_B)
    })

    it('paginates with a before=<ledger> cursor', async () => {
      await ev(10, 'joined', [VOTER_A, '10'])
      await ev(20, 'staked', [VOTER_A, '5', '5'])
      await ev(30, 'staked', [VOTER_A, '5', '10'])

      const res = await app.inject({ method: 'GET', url: `/api/members/${VOTER_A}/activity?before=30` })
      const { activity } = res.json()
      expect(activity.every((e: { ledger: number }) => e.ledger < 30)).toBe(true)
      expect(activity).toHaveLength(2)
    })

    it('400s on a malformed address', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/members/not-an-address/activity' })
      expect(res.statusCode).toBe(400)
    })
  })
})

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { MEMBER_ACTIVITY_SYMBOLS } from '../src/stellar/events.js'
import { closeDb, resetDb } from './db.js'

// Issue #193: GET /api/members/:address/activity?symbol=<one of
// MEMBER_ACTIVITY_SYMBOLS> narrows the feed; anything outside the set is a
// 400 rather than an empty page.

const MEMBER = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()

let seq = 0

async function ev(ledger: number, symbol: string, data: unknown[]): Promise<void> {
  seq += 1
  await query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, to_timestamp($3), 'CTEST', $4, $5, $6, $7)`,
    [
      `${String(ledger).padStart(10, '0')}-${String(seq).padStart(10, '0')}`,
      ledger,
      1_700_000_000 + ledger,
      symbol,
      JSON.stringify([symbol]),
      JSON.stringify(data),
      `tx-${ledger}-${seq}`,
    ]
  )
}

describe('GET /api/members/:address/activity?symbol= (issue #193)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    await ev(10, 'joined', [MEMBER, '10'])
    await ev(20, 'loan_vote', [7, MEMBER, true, null])
    await ev(30, 'staked', [MEMBER, '5', '5'])
    await ev(40, 'loan_vote', [8, MEMBER, false, null])
    await ev(50, 'loan_vote', [8, OTHER, true, null])
    await ev(60, 'staked', [MEMBER, '1', '6'])
  })
  afterAll(closeDb)

  it('the unfiltered default still returns every activity kind, newest first', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER}/activity` })
    expect(res.statusCode).toBe(200)
    expect(res.json().activity.map((e: { symbol: string }) => e.symbol)).toEqual([
      'staked',
      'loan_vote',
      'staked',
      'loan_vote',
      'joined',
    ])
  })

  it('a valid symbol returns only that kind, still scoped to the address', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER}/activity?symbol=loan_vote` })
    expect(res.statusCode).toBe(200)
    const { activity } = res.json()
    expect(activity.map((e: { symbol: string; ledger: number }) => [e.symbol, e.ledger])).toEqual([
      ['loan_vote', 40],
      ['loan_vote', 20],
    ])
    // The other member's vote at ledger 50 is not this member's activity.
    expect(activity.every((e: { fields: { voter: string } }) => e.fields.voter === MEMBER)).toBe(true)
  })

  it('composes with the before cursor and limit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/members/${MEMBER}/activity?symbol=staked&before=60&limit=1`,
    })
    expect(res.statusCode).toBe(200)
    const { activity } = res.json()
    expect(activity).toHaveLength(1)
    expect(activity[0].symbol).toBe('staked')
    expect(activity[0].ledger).toBe(30)
  })

  it('a symbol outside the member-activity set is rejected with 400, not an empty page', async () => {
    for (const bad of ['doc_attn', 'bogus', 'JOINED', 'joined%27%20OR%201=1']) {
      const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER}/activity?symbol=${bad}` })
      expect(res.statusCode, bad).toBe(400)
      // Fastify's querystring schema (the enum documented in OpenAPI) rejects
      // it first with VALIDATION_FAILED; the handler's own check is the
      // fallback. Either way the error names the parameter.
      expect(res.json().error, bad).toMatch(/symbol/)
      expect(['BAD_REQUEST', 'VALIDATION_FAILED']).toContain(res.json().code)
    }
  })

  it('an empty or repeated symbol parameter is rejected too', async () => {
    const empty = await app.inject({ method: 'GET', url: `/api/members/${MEMBER}/activity?symbol=` })
    expect(empty.statusCode).toBe(400)
    const repeated = await app.inject({
      method: 'GET',
      url: `/api/members/${MEMBER}/activity?symbol=joined&symbol=staked`,
    })
    expect(repeated.statusCode).toBe(400)
  })

  it('every symbol in MEMBER_ACTIVITY_SYMBOLS is accepted', async () => {
    for (const symbol of MEMBER_ACTIVITY_SYMBOLS) {
      const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER}/activity?symbol=${symbol}` })
      expect(res.statusCode, symbol).toBe(200)
      expect(res.json().activity.every((e: { symbol: string }) => e.symbol === symbol)).toBe(true)
    }
  })

  it('the OpenAPI schema documents the filter with the exact symbol set', async () => {
    const spec = (app as unknown as { swagger: () => { paths: Record<string, { get?: { parameters?: Array<{ name: string; schema?: { enum?: string[] } }> } }> } }).swagger()
    const params = spec.paths['/api/members/{address}/activity']?.get?.parameters ?? []
    const symbol = params.find((p) => p.name === 'symbol')
    expect(symbol?.schema?.enum).toEqual([...MEMBER_ACTIVITY_SYMBOLS])
  })
})

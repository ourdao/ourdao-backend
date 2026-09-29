import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { parseIntegerAmount, withLoanDerived } from '../src/api/loan-derived.js'
import { pool, query } from '../src/db/index.js'
import type { LoanRow } from '../src/types.js'
import { closeDb, resetDb } from './db.js'

const ALICE = Keypair.random().publicKey()

const loan = (over: Partial<LoanRow> = {}): LoanRow => ({
  id: 1,
  borrower: ALICE,
  amount: '1000',
  outstanding: '1080',
  total_repayment: '1080',
  status: 'active',
  approved_ledger: 10,
  due_time: null,
  repaid_ledger: null,
  defaulted_ledger: null,
  updated_at: new Date().toISOString(),
  ...over,
})

describe('withLoanDerived (issue #195)', () => {
  it('derives interest and repaid amounts from clean decimal strings', () => {
    const d = withLoanDerived(loan({ outstanding: '380' }))
    expect(d.interest_charge).toBe('80')
    expect(d.repaid_amount).toBe('700')
  })

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '170141183460469231731687303715884105727'
    expect(withLoanDerived(loan({ amount: big, total_repayment: big, outstanding: big })).interest_charge).toBe('0')
  })

  it('does not throw on a scaled or garbage amount; nulls the derived fields and logs', () => {
    const warnings: object[] = []
    const log = { warn: (o: object) => void warnings.push(o) }
    for (const bad of ['100.00', '', 'abc', '1e5', ' 5']) {
      const d = withLoanDerived(loan({ amount: bad }), log)
      expect(d.interest_charge).toBeNull()
      expect(d.repaid_amount).toBeNull()
      expect(d.id).toBe(1)
    }
    expect(warnings).toHaveLength(5)
    expect(warnings[0]).toMatchObject({ loanId: 1 })
    expect(parseIntegerAmount(null)).toBeNull()
  })
})

describe('malformed amounts through the API (issue #195)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  // Simulates the "future migration widens NUMERIC(40,0) to NUMERIC(40,2)"
  // scenario from the issue, then restores the schema.
  async function withScaledColumns(fn: () => Promise<void>): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('ALTER TABLE loans ALTER COLUMN amount TYPE NUMERIC(40,2)')
      await client.query('ALTER TABLE loans ALTER COLUMN outstanding TYPE NUMERIC(40,2)')
      await client.query('ALTER TABLE loans ALTER COLUMN total_repayment TYPE NUMERIC(40,2)')
      await fn()
    } finally {
      await client.query('TRUNCATE loans')
      await client.query('ALTER TABLE loans ALTER COLUMN amount TYPE NUMERIC(40,0)')
      await client.query('ALTER TABLE loans ALTER COLUMN outstanding TYPE NUMERIC(40,0)')
      await client.query('ALTER TABLE loans ALTER COLUMN total_repayment TYPE NUMERIC(40,0)')
      client.release()
    }
  }

  it('a scaled row degrades to null derived fields on all three endpoints instead of 500', async () => {
    await query(`INSERT INTO members (address, joined_ledger) VALUES ($1, 1)`, [ALICE])
    await withScaledColumns(async () => {
      await query(
        `INSERT INTO loans (id, borrower, amount, outstanding, total_repayment, status)
         VALUES (1, $1, '100.00', '100.00', '110.00', 'active')`,
        [ALICE]
      )
      const list = await app.inject({ method: 'GET', url: '/api/loans' })
      expect(list.statusCode).toBe(200)
      expect(list.json()[0]).toMatchObject({ id: 1, interest_charge: null, repaid_amount: null })

      const one = await app.inject({ method: 'GET', url: '/api/loans/1' })
      expect(one.statusCode).toBe(200)
      expect(one.json().interest_charge).toBeNull()

      const summary = await app.inject({ method: 'GET', url: `/api/members/${ALICE}/summary` })
      expect(summary.statusCode).toBe(200)
      expect(summary.json().loans).toHaveLength(1)
    })
  })
})

describe('amount columns keep scale zero (issue #195)', () => {
  afterAll(closeDb)

  it('every NUMERIC column in the public schema is NUMERIC(p,0)', async () => {
    const rows = await query<{ table_name: string; column_name: string; numeric_scale: number | null }>(
      `SELECT table_name, column_name, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric'`
    )
    expect(rows.length).toBeGreaterThan(0)
    const scaled = rows.filter((r) => r.numeric_scale !== 0).map((r) => `${r.table_name}.${r.column_name}`)
    expect(scaled).toEqual([])
  })
})

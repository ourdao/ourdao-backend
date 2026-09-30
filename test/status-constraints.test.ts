import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pool } from '../src/db/index.js'
import {
  LOAN_PROPOSAL_STATUSES,
  LOAN_STATUSES,
  TREASURY_PROPOSAL_STATUSES,
} from '../src/types.js'
import { closeDb, resetDb } from './db.js'

// #73 — the status columns now carry a CHECK constraint. These tests fail if
// the constraint is dropped, if it accepts a value outside the documented
// set, or if the DB constraint and the src/types.ts union drift apart.

interface Case {
  table: string
  constraint: string
  values: readonly string[]
  /** INSERT that sets `status = $1` and nothing else that would fail first. */
  insert: (id: number) => string
}

const CASES: Case[] = [
  {
    table: 'loan_proposals',
    constraint: 'loan_proposals_status_check',
    values: LOAN_PROPOSAL_STATUSES,
    insert: (id) =>
      `INSERT INTO loan_proposals (id, borrower, amount, status) VALUES (${id}, 'GBORROWER', 1, $1)`,
  },
  {
    table: 'loans',
    constraint: 'loans_status_check',
    values: LOAN_STATUSES,
    insert: (id) =>
      `INSERT INTO loans (id, borrower, amount, status) VALUES (${id}, 'GBORROWER', 1, $1)`,
  },
  {
    table: 'treasury_proposals',
    constraint: 'treasury_proposals_status_check',
    values: TREASURY_PROPOSAL_STATUSES,
    insert: (id) =>
      `INSERT INTO treasury_proposals (id, amount, destination, status) VALUES (${id}, 1, 'GDEST', $1)`,
  },
]

/** Pull the quoted values out of `pg_get_constraintdef` output, which
 *  normalises `status IN ('a','b')` to `status = ANY (ARRAY['a'::text, …])`. */
async function constraintValues(name: string): Promise<string[]> {
  const { rows } = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND connamespace = current_schema()::regnamespace`,
    [name],
  )
  expect(rows, `constraint ${name} must exist`).toHaveLength(1)
  return [...rows[0]!.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!).sort()
}

describe('status column CHECK constraints (#73)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  for (const c of CASES) {
    describe(c.table, () => {
      it('accepts every documented status value', async () => {
        let id = 1
        for (const value of c.values) {
          await expect(pool.query(c.insert(id++), [value])).resolves.toBeDefined()
        }
      })

      it('rejects a value outside the documented set', async () => {
        await expect(pool.query(c.insert(1), ['not-a-real-status'])).rejects.toMatchObject({
          code: '23514', // check_violation
        })
        await expect(pool.query(c.insert(2), [`${c.values[0]} `])).rejects.toMatchObject({
          code: '23514',
        })
      })

      it('the DB constraint matches src/types.ts exactly (fails on drift)', async () => {
        expect(await constraintValues(c.constraint)).toEqual([...c.values].sort())
      })
    })
  }
})

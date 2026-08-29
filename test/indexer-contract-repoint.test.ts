import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../src/db/index.js'
import { ensureCursorContract, resetForContractChange } from '../src/indexer/poller.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'

// Issue #16: repointing CONTRACT_ID at a new deployment must not silently
// merge two deployments' derived state. INDEXER_RESET_ON_CONTRACT_CHANGE is
// read at config import time and defaults to false in the test env, so these
// cover the default (refuse) path plus the reset primitive directly.
describe('indexer: contract repoint guard', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  async function seedCursor(contractId: string): Promise<void> {
    await pool.query(
      `INSERT INTO indexer_cursor (id, paging_token, last_ledger, contract_id)
       VALUES (1, 'tok', 42, $1)
       ON CONFLICT (id) DO UPDATE SET contract_id = $1`,
      [contractId]
    )
  }

  it('refuses to start when the saved cursor belongs to a different contract', async () => {
    await seedCursor('COLDCONTRACT')
    await expect(ensureCursorContract('CNEWCONTRACT')).rejects.toThrow(/belongs to contract COLDCONTRACT/)
  })

  it('is a no-op when the cursor matches the configured contract', async () => {
    await seedCursor('CSAME')
    await expect(ensureCursorContract('CSAME')).resolves.toBeUndefined()
    const rows = await query('SELECT * FROM indexer_cursor WHERE id = 1')
    expect(rows).toHaveLength(1)
  })

  it('is a no-op on a cold start with no saved cursor', async () => {
    await expect(ensureCursorContract('CANYTHING')).resolves.toBeUndefined()
  })

  it('resetForContractChange clears the cursor and all derived tables but keeps the raw events log', async () => {
    const client = await pool.connect()
    try {
      await applyEvent(client, decodedEvent('joined', { member: 'GA', fee: '10' }))
      await applyEvent(client, decodedEvent('loan_req', { id: 1, borrower: 'GA', amount: '5', total_repayment: '6' }))
      await applyEvent(client, decodedEvent('interest', { interest: '1', active_members: 1 }))
    } finally {
      client.release()
    }
    // Seed dao_totals with non-zero values from a "previous deployment"
    await pool.query(
      `UPDATE dao_totals SET interest_collected = 999, principal_lent = 888,
       principal_repaid = 777, value_defaulted = 666 WHERE id = 1`
    )
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('raw-1', 100, now(), 'COLDCONTRACT', 'joined', '[]', '[]')`
    )
    await seedCursor('COLDCONTRACT')

    await resetForContractChange()

    expect(await query('SELECT * FROM members')).toEqual([])
    expect(await query('SELECT * FROM loan_proposals')).toEqual([])
    expect(await query('SELECT * FROM loans')).toEqual([])
    expect(await query('SELECT * FROM treasury_proposals')).toEqual([])
    expect(await query('SELECT * FROM notifications')).toEqual([])
    expect(await query('SELECT * FROM interest_distributions')).toEqual([])
    expect(await query('SELECT * FROM indexer_cursor')).toEqual([])
    // dao_totals must be zeroed, not left with the previous deployment's figures.
    const totals = await pool.query<{ interest_collected: string; principal_lent: string; principal_repaid: string; value_defaulted: string }>(
      'SELECT interest_collected, principal_lent, principal_repaid, value_defaulted FROM dao_totals WHERE id = 1'
    )
    expect(totals.rows[0]!.interest_collected).toBe('0')
    expect(totals.rows[0]!.principal_lent).toBe('0')
    expect(totals.rows[0]!.principal_repaid).toBe('0')
    expect(totals.rows[0]!.value_defaulted).toBe('0')
    // The append-only audit trail is untouched.
    expect((await query('SELECT * FROM events')).length).toBeGreaterThan(0)
  })
})

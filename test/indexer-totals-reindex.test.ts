import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query, queryOne } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { fetchOnce, ReorgDetectedError } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

// Only poller.ts pulls in stellar/rpc.ts; mocking it here keeps the network
// out and lets the discontinuity test drive getLatestLedgerInfo. The RPC's
// reported tip (sequence 40) sits below the cursor the test seeds (500).
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: vi.fn().mockResolvedValue({ events: [] }), getLatestLedger: vi.fn() },
  getLatestLedger: vi.fn().mockResolvedValue(40),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 40, hash: 'HASH_LOW' }),
}))

/** Simulate one ingested event: raw log row + derived fold, the way
 *  poller.ingestPage does. */
async function ingest(client: PoolClient, ev: DecodedEvent): Promise<void> {
  await client.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol,
     JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
  )
  await applyEvent(client, ev)
}

async function totals(): Promise<Record<string, string>> {
  const r = await queryOne<{
    interest_collected: string
    principal_lent: string
    principal_repaid: string
    value_defaulted: string
  }>('SELECT interest_collected, principal_lent, principal_repaid, value_defaulted FROM dao_totals WHERE id = 1')
  return {
    interest: r!.interest_collected,
    lent: r!.principal_lent,
    repaid: r!.principal_repaid,
    defaulted: r!.value_defaulted,
  }
}

describe('indexer: dao_totals folding (issue #24)', () => {
  let client: PoolClient
  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => {
    try { client.release() } catch { /* already released */ }
  })
  afterAll(closeDb)

  it('folds interest events into the lifetime total and the distribution history', async () => {
    await ingest(client, decodedEvent('interest', { interest: '300', active: 3 }))
    await ingest(client, decodedEvent('interest', { interest: '450', active: 5 }))

    expect((await totals()).interest).toBe('750')

    const dist = await query<{ amount: string; active_members: number }>(
      'SELECT amount, active_members FROM interest_distributions ORDER BY ledger'
    )
    expect(dist).toHaveLength(2)
    expect(dist[0]).toMatchObject({ amount: '300', active_members: 3 })
    expect(dist[1]).toMatchObject({ amount: '450', active_members: 5 })
  })

  it('re-delivering an interest event does not double-count', async () => {
    const ev = decodedEvent('interest', { interest: '300', active: 3 })
    await ingest(client, ev)
    await ingest(client, ev) // same event id
    await applyEvent(client, ev) // even a direct re-apply

    expect((await totals()).interest).toBe('300')
    expect(await query('SELECT * FROM interest_distributions')).toHaveLength(1)
  })

  it('folds principal lent, principal repaid, and value defaulted from loan events', async () => {
    await ingest(client, decodedEvent('joined', { member: 'GB', fee: '10' }))
    await ingest(client, decodedEvent('loan_req', { id: 1, borrower: 'GB', amount: '1000', total_repayment: '1100' }))
    await ingest(client, decodedEvent('loan_appr', { id: 1, borrower: 'GB', amount: '1000' }))
    expect((await totals()).lent).toBe('1000')

    await ingest(client, decodedEvent('loan_rpy', { loan_id: 1, borrower: 'GB', outstanding: '600' }))
    await ingest(client, decodedEvent('loan_rpy', { loan_id: 1, borrower: 'GB', outstanding: '0' }))
    expect((await totals()).repaid).toBe('1000') // principal, folded once on full repayment

    await ingest(client, decodedEvent('joined', { member: 'GC', fee: '10' }))
    await ingest(client, decodedEvent('loan_req', { id: 2, borrower: 'GC', amount: '500', total_repayment: '550' }))
    await ingest(client, decodedEvent('loan_appr', { id: 2, borrower: 'GC', amount: '500' }))
    await ingest(client, decodedEvent('loan_dflt', { loan_id: 2, borrower: 'GC', penalty: '50' }))
    expect((await totals()).defaulted).toBe('550') // outstanding at default (seeded from total_repayment)
    expect((await totals()).lent).toBe('1500')
  })

  it('re-delivering loan_appr / loan_dflt does not double-count the totals', async () => {
    await ingest(client, decodedEvent('joined', { member: 'GB', fee: '10' }))
    const appr = decodedEvent('loan_req', { id: 3, borrower: 'GB', amount: '200', total_repayment: '220' })
    await ingest(client, appr)
    const apprEv = decodedEvent('loan_appr', { id: 3, borrower: 'GB', amount: '200' })
    await ingest(client, apprEv)
    await applyEvent(client, apprEv) // re-apply the fold directly
    expect((await totals()).lent).toBe('200')

    const dflt = decodedEvent('loan_dflt', { loan_id: 3, borrower: 'GB', penalty: '20' })
    await ingest(client, dflt)
    await applyEvent(client, dflt)
    expect((await totals()).defaulted).toBe('220')
  })
})

describe('indexer: reindex from the raw event log (issue #23)', () => {
  let client: PoolClient
  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })
  afterEach(() => {
    try { client.release() } catch { /* already released */ }
  })
  afterAll(closeDb)

  it('a rebuild from the events log reproduces the incremental fold exactly', async () => {
    const events = [
      decodedEvent('joined', { member: 'GB', fee: '100' }),
      decodedEvent('staked', { member: 'GB', amount: '400', new_stake: '400' }),
      decodedEvent('interest', { interest: '90', active: 2 }),
      decodedEvent('loan_req', { id: 1, borrower: 'GB', amount: '1000', total_repayment: '1100' }),
      decodedEvent('loan_vote', { proposal_id: 1, voter: 'GB', support: true }),
      decodedEvent('loan_appr', { id: 1, borrower: 'GB', amount: '1000' }),
      decodedEvent('loan_rpy', { loan_id: 1, borrower: 'GB', outstanding: '0' }),
      decodedEvent('tre_prop', { id: 1, amount: '5000', destination: 'GD', private: false }),
      decodedEvent('tre_vote', { id: 1, voter: 'GB', support: true }),
      decodedEvent('joined', { member: 'GC', fee: '50' }),
      decodedEvent('loan_req', { id: 2, borrower: 'GC', amount: '300', total_repayment: '330' }),
      decodedEvent('loan_appr', { id: 2, borrower: 'GC', amount: '300' }),
      decodedEvent('loan_dflt', { loan_id: 2, borrower: 'GC', penalty: '30' }),
    ]
    for (const ev of events) await ingest(client, ev)

    const before = {
      members: await query('SELECT address, contribution, stake, has_active_loan, defaults_count, exited FROM members ORDER BY address'),
      loans: await query('SELECT id, borrower, amount, outstanding, total_repayment, status FROM loans ORDER BY id'),
      proposals: await query('SELECT id, status, votes_for, voter_count FROM loan_proposals ORDER BY id'),
      treasury: await query('SELECT id, status, votes_for, voter_count FROM treasury_proposals ORDER BY id'),
      totals: await totals(),
      interest: await query('SELECT event_id, amount, active_members FROM interest_distributions ORDER BY ledger'),
    }

    client.release()
    const { events: replayed } = await reindexFromEventLog()
    expect(replayed).toBe(events.length)
    client = await pool.connect()

    const after = {
      members: await query('SELECT address, contribution, stake, has_active_loan, defaults_count, exited FROM members ORDER BY address'),
      loans: await query('SELECT id, borrower, amount, outstanding, total_repayment, status FROM loans ORDER BY id'),
      proposals: await query('SELECT id, status, votes_for, voter_count FROM loan_proposals ORDER BY id'),
      treasury: await query('SELECT id, status, votes_for, voter_count FROM treasury_proposals ORDER BY id'),
      totals: await totals(),
      interest: await query('SELECT event_id, amount, active_members FROM interest_distributions ORDER BY ledger'),
    }

    expect(after).toEqual(before)
  })

  it('a rebuild with batched keyset pagination produces identical state across small batch sizes', async () => {
    const events = [
      decodedEvent('joined', { member: 'GB', fee: '100' }),
      decodedEvent('staked', { member: 'GB', amount: '400', new_stake: '400' }),
      decodedEvent('interest', { interest: '90', active: 2 }),
      decodedEvent('loan_req', { id: 1, borrower: 'GB', amount: '1000', total_repayment: '1100' }),
      decodedEvent('loan_vote', { proposal_id: 1, voter: 'GB', support: true }),
      decodedEvent('loan_appr', { id: 1, borrower: 'GB', amount: '1000' }),
      decodedEvent('loan_rpy', { loan_id: 1, borrower: 'GB', outstanding: '0' }),
    ]
    for (const ev of events) await ingest(client, ev)

    const before = {
      members: await query('SELECT address, contribution, stake, has_active_loan, defaults_count, exited FROM members ORDER BY address'),
      loans: await query('SELECT id, borrower, amount, outstanding, total_repayment, status FROM loans ORDER BY id'),
      proposals: await query('SELECT id, status, votes_for, voter_count FROM loan_proposals ORDER BY id'),
      totals: await totals(),
      interest: await query('SELECT event_id, amount, active_members FROM interest_distributions ORDER BY ledger'),
    }

    client.release()
    // Test with small batch size of 2 to force multiple pagination roundtrips
    const { events: replayed } = await reindexFromEventLog({ batchSize: 2 })
    expect(replayed).toBe(events.length)
    client = await pool.connect()

    const after = {
      members: await query('SELECT address, contribution, stake, has_active_loan, defaults_count, exited FROM members ORDER BY address'),
      loans: await query('SELECT id, borrower, amount, outstanding, total_repayment, status FROM loans ORDER BY id'),
      proposals: await query('SELECT id, status, votes_for, voter_count FROM loan_proposals ORDER BY id'),
      totals: await totals(),
      interest: await query('SELECT event_id, amount, active_members FROM interest_distributions ORDER BY ledger'),
    }

    expect(after).toEqual(before)
  })
})

describe('indexer: ledger discontinuity detection (issue #23)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('halts when the RPC tip is below the last folded ledger', async () => {
    await query(
      `INSERT INTO indexer_cursor (id, paging_token, last_ledger, contract_id)
       VALUES (1, 'tok', 500, 'CTESTCONTRACT')
       ON CONFLICT (id) DO UPDATE SET paging_token = 'tok', last_ledger = 500, contract_id = 'CTESTCONTRACT'`
    )
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
  })
})

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { reindexFromEventLog, REINDEX_LOCK_KEY, ReindexLockError } from '../src/indexer/reindex.js'
import { fetchOnce, resetForContractChange } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'
import { applyEvent } from '../src/indexer/handlers.js'

vi.mock('../src/stellar/rpc.js', () => ({
  server: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn().mockResolvedValue(100),
  },
  getLatestLedger: vi.fn().mockResolvedValue(100),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100, hash: 'HASH_100' }),
}))

import { server } from '../src/stellar/rpc.js'

async function insertEvent(client: PoolClient, ev: DecodedEvent): Promise<void> {
  await client.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [
      ev.id,
      ev.ledger,
      ev.closedAt,
      ev.contractId,
      ev.symbol,
      JSON.stringify(ev.topics),
      JSON.stringify(ev.data),
      ev.txHash,
    ]
  )
  await applyEvent(client, ev)
}

describe('indexer: reindex advisory locking', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
  })

  afterEach(() => {
    try {
      client.release()
    } catch {
      // already released
    }
  })

  afterAll(closeDb)

  it('refuses a concurrent reindex with ReindexLockError when the advisory lock is already held', async () => {
    // Acquire the advisory lock manually on a dedicated client session
    const lockAcquired = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [REINDEX_LOCK_KEY]
    )
    expect(lockAcquired.rows[0]?.pg_try_advisory_lock).toBe(true)

    // A concurrent reindexFromEventLog call must fail fast without running TRUNCATE
    await expect(reindexFromEventLog()).rejects.toThrow(ReindexLockError)

    // Unlock on the holding client
    await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])

    // Now reindex proceeds normally
    const res = await reindexFromEventLog()
    expect(res.events).toBe(0)
  })

  it('refuses indexer worker page ingestion while reindex holds the advisory lock', async () => {
    // Seed an event first
    const ev = decodedEvent('joined', { member: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYORMA3Y4H3WB7KT7NX', fee: '100' })
    await insertEvent(client, ev)

    // Mock RPC returning a new event
    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [
        {
          id: '200-0',
          ledger: 200,
          ledgerClosedAt: '2026-01-01T00:00:00Z',
          contractId: 'CTESTCONTRACT',
          txHash: 'tx-200',
          topic: ['joined'],
          value: ['GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYORMA3Y4H3WB7KT7NX', '50'],
          inSuccessfulContractCall: true,
          pagingToken: 'tok-200',
        } as unknown as import('@stellar/stellar-sdk').rpc.Api.EventResponse,
      ],
      cursor: 'tok-200',
      latestLedger: 200,
    } as unknown as import('@stellar/stellar-sdk').rpc.Api.GetEventsResponse)

    // Hold the advisory lock
    await client.query('SELECT pg_advisory_lock($1)', [REINDEX_LOCK_KEY])

    // Indexer fetchOnce attempting ingestPage must fail
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/reindex is currently in progress/)

    // Release lock
    await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])

    // Verify raw events log does not have the un-folded event
    const events = await query<{ id: string }>('SELECT id FROM events WHERE id = $1', ['200-0'])
    expect(events).toHaveLength(0)
  })

  it('refuses resetForContractChange while advisory lock is held', async () => {
    await client.query('SELECT pg_advisory_lock($1)', [REINDEX_LOCK_KEY])

    await expect(resetForContractChange()).rejects.toThrow(/advisory lock held/)

    await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])

    await expect(resetForContractChange()).resolves.toBeUndefined()
  })

  it('releases the advisory lock on error during reindex', async () => {
    // Put a bad event row that will fail during reindex
    await client.query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
       VALUES ('bad-1', 1, now(), 'CTEST', 'loan_dflt', '[]', '{"loan_id": 999999, "borrower": "GB", "penalty": "bad_amount"}', 'tx-1')`
    )

    // reindex should throw due to invalid amount
    await expect(reindexFromEventLog()).rejects.toThrow()

    // The lock must have been released, so another connection can acquire it immediately
    const lockCheck = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [REINDEX_LOCK_KEY]
    )
    expect(lockCheck.rows[0]?.pg_try_advisory_lock).toBe(true)
    await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])
  })
})

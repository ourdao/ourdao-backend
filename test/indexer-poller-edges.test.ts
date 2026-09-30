import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query, queryOne } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Edge paths of the poll loop and the replay lock that the happy-path suites
// never reach: RPC responses missing optional fields, a second runIndexer
// while one is running, stopping an idle indexer, replaying while the fold
// lock is held, and replaying a quarantine record whose raw row is gone.

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...actual,
    config: { ...actual.config, stellar: { ...actual.config.stellar, contractId: 'CTESTEDGE', contractIds: ['CTESTEDGE'] } },
    assertContractConfigured: () => 'CTESTEDGE',
    assertContractsConfigured: () => ['CTESTEDGE'],
  }
})

const getEventsMock = vi.fn()
const getLedgerHashMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
  getLedgerHash: (...args: unknown[]) => getLedgerHashMock(...(args as [number])),
}))

const { fetchOnce, runIndexer, stopIndexer } = await import('../src/indexer/poller.js')
const { replayFailedEvent, ReplayLockError } = await import('../src/indexer/replay.js')
const { REINDEX_LOCK_KEY } = await import('../src/indexer/reindex.js')

const CONTRACT = 'CTESTEDGE'

async function cursorRow() {
  return queryOne<{ paging_token: string | null; last_ledger: number | null; observed_tip_ledger: number | null }>(
    'SELECT paging_token, last_ledger, observed_tip_ledger FROM indexer_cursor WHERE contract_id = $1',
    [CONTRACT]
  )
}

describe('poll loop edge cases', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
    getLedgerHashMock.mockReset()
    getLedgerHashMock.mockResolvedValue('HASH_500')
    await query(
      `INSERT INTO indexer_cursor (contract_id, paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, updated_at)
       VALUES ($1, 'tok', 500, 'HASH_500', 600, now())`,
      [CONTRACT]
    )
  })
  afterAll(closeDb)

  it('tolerates an RPC page with no events, cursor or latestLedger fields', async () => {
    getEventsMock.mockResolvedValueOnce({})
    await fetchOnce(CONTRACT)
    const row = await cursorRow()
    // Nothing folded: the paging token is carried over from the request and
    // the observed tip keeps the stored value when the page carries none.
    expect(row?.paging_token).toBe('tok')
    expect(row?.last_ledger).toBe(500)
    expect(row?.observed_tip_ledger).toBe(600)
  })

  it('advances the paging token from an empty page that carries a cursor but no tip', async () => {
    getEventsMock.mockResolvedValueOnce({ events: [], cursor: 'tok-next' })
    await fetchOnce(CONTRACT)
    const row = await cursorRow()
    expect(row?.paging_token).toBe('tok-next')
    expect(row?.last_ledger).toBe(500)
  })

  it('refuses a second runIndexer while one is running, and stopping an idle indexer is a no-op', async () => {
    await expect(stopIndexer()).resolves.toBeUndefined()

    getEventsMock.mockResolvedValue({ events: [], cursor: 'tok', latestLedger: 100_000 })
    const run = runIndexer()
    await vi.waitFor(() => expect(getEventsMock).toHaveBeenCalled())
    await expect(runIndexer()).rejects.toThrow(/already running/)
    await stopIndexer()
    await run
    // The latch is released on exit, so a fresh start is possible.
    await expect(stopIndexer()).resolves.toBeUndefined()
  })
})

describe('replay edge cases', () => {
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(closeDb)

  it('refuses to replay while another session holds the fold lock', async () => {
    const holder = await pool.connect()
    try {
      const got = await holder.query<{ pg_try_advisory_lock: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext(current_schema()))',
        [REINDEX_LOCK_KEY]
      )
      expect(got.rows[0]?.pg_try_advisory_lock).toBe(true)
      await expect(replayFailedEvent('1-0')).rejects.toBeInstanceOf(ReplayLockError)
      await expect(replayFailedEvent('1-0')).rejects.toMatchObject({ statusCode: 409 })
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [REINDEX_LOCK_KEY])
      holder.release()
    }
  })

  it('reports the inconsistency when a quarantine record has no raw event row', async () => {
    await query(`INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('9-0', 'joined', 9, 'boom')`)
    await expect(replayFailedEvent('9-0')).rejects.toThrow(/no matching row in events/)
  })
})

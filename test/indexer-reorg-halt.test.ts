import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { query, queryOne } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #191: a detected ledger discontinuity is persisted before the worker
// exits, the next start refuses to resume until it is cleared, and a
// completed reindex clears it.

// test/setup.ts resolves `config` (without a contract id) before this file's
// imports run, so point the indexer at a contract through the module mock.
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...actual,
    config: { ...actual.config, stellar: { ...actual.config.stellar, contractId: 'CTESTREORG', contractIds: ['CTESTREORG'] } },
    assertContractConfigured: () => 'CTESTREORG',
    assertContractsConfigured: () => ['CTESTREORG'],
  }
})

const getEventsMock = vi.fn()
const getLatestLedgerInfoMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: (...args: unknown[]) => getLatestLedgerInfoMock(...(args as [])),
  getLedgerHash: vi.fn().mockResolvedValue(null),
}))

const {
  runIndexer,
  ReorgDetectedError,
  ReorgHaltedError,
  loadUnclearedReorgHalt,
  clearReorgHalts,
  recordReorgHalt,
} = await import('../src/indexer/poller.js')
const { reindexFromEventLog } = await import('../src/indexer/reindex.js')
const { clearRecordedReorg } = await import('../src/indexer/clear-reorg.js')

const CONTRACT = 'CTESTREORG'

async function halts(): Promise<Array<{ contract_id: string; last_ledger: number | null; detail: string; cleared_by: string | null; cleared_at: string | null }>> {
  return query(
    'SELECT contract_id, last_ledger, detail, cleared_by, cleared_at FROM reorg_halts ORDER BY id'
  )
}

describe('indexer: a detected reorg is recorded and blocks resumption (issue #191)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
    getLatestLedgerInfoMock.mockReset()
    // The cursor says ledger 500 was folded; the RPC now reports a tip below
    // it — the coarse rewind check fires on the first poll.
    await query(
      `INSERT INTO indexer_cursor (contract_id, paging_token, last_ledger, last_ledger_hash, updated_at)
       VALUES ($1, 'tok', 500, 'HASH_500', now())`,
      [CONTRACT]
    )
    getLatestLedgerInfoMock.mockResolvedValue({ sequence: 100, hash: 'HASH_TIP' })
  })
  afterAll(closeDb)

  it('runIndexer halts on the discontinuity and persists it with the cursor position', async () => {
    await expect(runIndexer()).rejects.toBeInstanceOf(ReorgDetectedError)
    expect(getEventsMock).not.toHaveBeenCalled()

    const rows = await halts()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ contract_id: CONTRACT, last_ledger: 500, cleared_at: null, cleared_by: null })
    expect(rows[0]!.detail).toMatch(/below the last folded ledger 500/)

    const open = await loadUnclearedReorgHalt()
    expect(open?.last_ledger_hash).toBe('HASH_500')
  })

  it('a restart refuses to resume while the halt is uncleared, even when the chain looks fine again', async () => {
    await expect(runIndexer()).rejects.toBeInstanceOf(ReorgDetectedError)

    // The chain "recovers" — the tip is ahead again — which is exactly the
    // case a restart would previously have resumed through.
    getLatestLedgerInfoMock.mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' })
    getEventsMock.mockResolvedValue({ events: [], cursor: 'tok', latestLedger: 100_000 })

    await expect(runIndexer()).rejects.toBeInstanceOf(ReorgHaltedError)
    await expect(runIndexer()).rejects.toThrow(/npm run reindex/)
    expect(getEventsMock).not.toHaveBeenCalled()
    // Refusing to start must not leave the "already running" latch set.
    await expect(runIndexer()).rejects.toBeInstanceOf(ReorgHaltedError)
  })

  it('a completed reindex clears the halt in the same transaction, after which the worker may start', async () => {
    await expect(runIndexer()).rejects.toBeInstanceOf(ReorgDetectedError)

    await reindexFromEventLog()

    const rows = await halts()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cleared_by).toBe('reindex')
    expect(rows[0]!.cleared_at).not.toBeNull()
    expect(await loadUnclearedReorgHalt()).toBeNull()

    // With the halt cleared and a healthy chain the next start gets past the
    // guard: the first poll now reaches the RPC.
    getLatestLedgerInfoMock.mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' })
    getEventsMock.mockRejectedValue(new Error('stop here'))
    const run = runIndexer()
    await vi.waitFor(() => expect(getEventsMock).toHaveBeenCalled())
    const { stopIndexer } = await import('../src/indexer/poller.js')
    await stopIndexer()
    await run
  })

  it('an operator can clear a false alarm without rebuilding, and the history is kept', async () => {
    await recordReorgHalt(CONTRACT, new ReorgDetectedError('first'))
    await recordReorgHalt(CONTRACT, new ReorgDetectedError('second'))
    expect((await loadUnclearedReorgHalt())?.detail).toBe('second')

    expect(await clearReorgHalts('operator')).toBe(2)
    expect(await loadUnclearedReorgHalt()).toBeNull()
    expect(await clearReorgHalts('operator')).toBe(0)

    const rows = await halts()
    expect(rows.map((r) => [r.detail, r.cleared_by])).toEqual([
      ['first', 'operator'],
      ['second', 'operator'],
    ])
  })

  it('records a halt even when no cursor row exists, and the refusal says the ledger is unknown', async () => {
    await query('DELETE FROM indexer_cursor')
    await recordReorgHalt(CONTRACT, new ReorgDetectedError('no cursor yet'))
    const open = await loadUnclearedReorgHalt()
    expect(open).toMatchObject({ contract_id: CONTRACT, last_ledger: null, last_ledger_hash: null, detail: 'no cursor yet' })
    await expect(runIndexer()).rejects.toThrow(/last folded ledger unknown/)
  })

  it('npm run reorg:clear acknowledges the open halt and reports a no-op when there is none', async () => {
    const lines: string[] = []
    const log = { log: (m: string) => lines.push(m) }

    expect(await clearRecordedReorg(log)).toEqual({ halt: null, cleared: 0 })
    expect(lines.at(-1)).toMatch(/nothing to do/)

    await recordReorgHalt(CONTRACT, new ReorgDetectedError('rpc served a stale hash'))
    const result = await clearRecordedReorg(log)
    expect(result.cleared).toBe(1)
    expect(result.halt?.detail).toBe('rpc served a stale hash')
    expect(lines.join('\n')).toMatch(/last folded ledger 500/)
    expect(lines.at(-1)).toMatch(/cleared 1 record/)
    expect(await loadUnclearedReorgHalt()).toBeNull()
    expect((await halts())[0]?.cleared_by).toBe('operator')
  })

  it('recording never masks the halt: a failed insert is logged and the error still propagates', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Make the INSERT fail while reads keep working (the start-up check
      // still has to see "no halt recorded").
      await query('ALTER TABLE reorg_halts ADD CONSTRAINT reorg_halts_test_block CHECK (detail <> detail)')
      await expect(runIndexer()).rejects.toBeInstanceOf(ReorgDetectedError)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to record the ledger discontinuity'),
        expect.anything()
      )
    } finally {
      await query('ALTER TABLE reorg_halts DROP CONSTRAINT reorg_halts_test_block')
      errorSpy.mockRestore()
    }
    expect(await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM reorg_halts')).toEqual({ n: 0 })
  })
})

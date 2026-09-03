// Covers issue #43 (quarantine path for a deterministically-throwing
// handler) and issue #45 (the empty-page cursor conflation that produced a
// false ReorgDetectedError). Both live in src/indexer/poller.ts and share
// the same mock setup, so one file.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query, queryOne } from '../src/db/index.js'
import { fetchOnce, ReorgDetectedError } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

// The handlers only ever read ev.fields/ev.ledger/ev.txHash (see
// test/fixtures.ts), so bypass real ScVal decoding here too — the fixture
// events built by decodedEvent() are already full DecodedEvents.
vi.mock('../src/stellar/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stellar/events.js')>()
  return { ...actual, decodeEvent: (raw: unknown) => raw as DecodedEvent }
})

const getEventsMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
}))

async function cursorRow() {
  return queryOne<{ last_ledger: number | null; observed_tip_ledger: number | null; paging_token: string | null }>(
    'SELECT last_ledger, observed_tip_ledger, paging_token FROM indexer_cursor WHERE id = 1'
  )
}

describe('indexer: quarantine after repeated same-page failures (issue #43)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
  })
  afterAll(closeDb)

  it('quarantines the offending event after the configured threshold, folding the rest of the page and keeping the raw log intact', async () => {
    const good1 = decodedEvent('joined', { member: 'GA', fee: '10' })
    // loan_dflt with no penalty field — FieldValidationError (issue #42),
    // deterministic every time this exact page is retried.
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const good2 = decodedEvent('joined', { member: 'GB', fee: '20' })
    const page = [good1, bad, good2]
    getEventsMock.mockResolvedValue({ events: page, cursor: 'tok-after', latestLedger: 100_000 })

    // Default INDEXER_QUARANTINE_AFTER_FAILURES is 3: the first two attempts
    // are still treated as possibly-transient and rethrow so runIndexer's
    // normal backoff gets a chance.
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    // Third consecutive identical failure on the same page — quarantine.
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA', 'GB'])

    const failed = await query<{ event_id: string; symbol: string; error: string }>(
      'SELECT event_id, symbol, error FROM failed_events'
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]?.symbol).toBe('loan_dflt')
    expect(failed[0]?.event_id).toBe(bad.id)
    expect(failed[0]?.error).toMatch(/penalty/)

    // The raw log is untouched/complete for all three events, including the
    // quarantined one — CONTRIBUTING: never mutate or delete an events row.
    const rawIds = await query<{ id: string }>('SELECT id FROM events ORDER BY id')
    expect(rawIds.map((r) => r.id).sort()).toEqual([good1.id, bad.id, good2.id].sort())

    // The cursor advanced past the quarantined event — indexing continues.
    // (Cursor token prefers the last event's own id over the page response's
    // cursor — see fetchOnce's `nextToken` derivation.)
    const row = await cursorRow()
    expect(row?.paging_token).toBe(good2.id)
  })

  it('does not quarantine before the failure threshold — a fresh page attempt each poll still rolls back and retries as transient', async () => {
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    getEventsMock.mockResolvedValue({ events: [bad], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)

    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
    // Whole-page transaction rolled back — nothing persisted for a failure
    // that hasn't hit the quarantine threshold yet.
    expect(await query('SELECT * FROM events')).toHaveLength(0)
  })

  it('a transient failure that clears before the threshold is never quarantined', async () => {
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const good = decodedEvent('joined', { member: 'GA', fee: '10' })
    // Two failures (below the threshold of 3), then the underlying problem
    // clears — e.g. a redelivered RPC page that decodes cleanly this time.
    getEventsMock
      .mockResolvedValueOnce({ events: [bad], cursor: 'tok', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [bad], cursor: 'tok', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [good], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()

    // Recovered on its own — nothing was ever quarantined, and the failure
    // counter reset (a later unrelated failure would need to start over).
    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
    expect(await query<{ address: string }>('SELECT address FROM members')).toHaveLength(1)
  })

  it('a genuine rewind still halts the indexer and is never quarantined', async () => {
    await pool.query(
      `INSERT INTO indexer_cursor (id, paging_token, last_ledger, contract_id)
       VALUES (1, 'tok', 500, 'CTESTCONTRACT')`
    )
    const reorgEv = decodedEvent('joined', { member: 'GX', fee: '1' }, { ledger: 100 })
    getEventsMock.mockResolvedValue({ events: [reorgEv], cursor: 'tok2', latestLedger: 100_000 })

    // Repeat past the quarantine threshold — a reorg must keep throwing every
    // time, never falling into per-event quarantine mode.
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)

    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
    expect(await query('SELECT * FROM events')).toHaveLength(0)
  })
})
  it('continues past a failed failed_events insert so a bookkeeping error does not strand the page (issue #120)', async () => {
    const good = decodedEvent('joined', { member: 'GA', fee: '10' })
    const bad = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' })
    const page = [good, bad]
    getEventsMock.mockResolvedValue({ events: page, cursor: 'tok-after', latestLedger: 100_000 })

    // First two attempts are still treated as transient whole-page failures.
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toThrow(/penalty/)

    // Third attempt: quarantine mode. Make the failed_events INSERT throw.
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (text, params) => {
      if (typeof text === 'string' && text.includes('INSERT INTO failed_events')) {
        throw new Error('simulated failed_events insert failure')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (pool.query as any).getMockImplementation?.() ?? pool.query(text as any, params as any)
    })

    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()

    spy.mockRestore()

    // The good event folded; the bad event was rolled back and not recorded
    // because the bookkeeping insert itself failed.
    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA'])
    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)

    // Raw log has both events.
    const rawIds = await query<{ id: string }>('SELECT id FROM events ORDER BY id')
    expect(rawIds.map((r) => r.id).sort()).toEqual([good.id, bad.id].sort())

    // Cursor advanced past the page so indexing is not stranded.
    const row = await cursorRow()
    expect(row?.paging_token).toBe(bad.id)
  })


describe('indexer: last_ledger vs observed_tip_ledger (issue #45)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
  })
  afterAll(closeDb)

  it('an empty page never advances last_ledger to the RPC tip, so a later real page below that tip is not a false reorg', async () => {
    // 1. Cold start, non-empty page at ledger 600.
    const first = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 600 })
    getEventsMock.mockResolvedValueOnce({ events: [first], cursor: 'tok-1', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    expect((await cursorRow())?.last_ledger).toBe(600)

    // 2. Empty page — must NOT pull last_ledger up to the chain tip.
    getEventsMock.mockResolvedValueOnce({ events: [], cursor: 'tok-1', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    const afterEmpty = await cursorRow()
    expect(afterEmpty?.last_ledger).toBe(600)
    expect(afterEmpty?.observed_tip_ledger).toBe(100_000)

    // 3. A real page arrives at ledger 650 — legitimately below the chain
    // tip (100000), and below what the old conflated last_ledger would have
    // become. Must fold cleanly, not raise ReorgDetectedError.
    const second = decodedEvent('joined', { member: 'GB', fee: '10' }, { ledger: 650 })
    getEventsMock.mockResolvedValueOnce({ events: [second], cursor: 'tok-2', latestLedger: 100_000 })
    await expect(fetchOnce('CTESTCONTRACT')).resolves.toBeUndefined()
    expect((await cursorRow())?.last_ledger).toBe(650)

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA', 'GB'])
  })

  it('a genuine rewind — an event below the actual folded high-water mark — still raises ReorgDetectedError', async () => {
    const first = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 600 })
    getEventsMock.mockResolvedValueOnce({ events: [first], cursor: 'tok-1', latestLedger: 100_000 })
    await fetchOnce('CTESTCONTRACT')
    expect((await cursorRow())?.last_ledger).toBe(600)

    const rewound = decodedEvent('joined', { member: 'GB', fee: '10' }, { ledger: 590 })
    getEventsMock.mockResolvedValueOnce({ events: [rewound], cursor: 'tok-2', latestLedger: 100_000 })
    await expect(fetchOnce('CTESTCONTRACT')).rejects.toBeInstanceOf(ReorgDetectedError)
  })
})

// Issue #138: the drain loop must use the same cursor token it persists.
// Set page limit to 1 before importing poller so a two-event page becomes a drain.
process.env.EVENTS_PAGE_LIMIT = '1'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchOnce } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

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

describe('indexer: drain cursor consistency (issue #138)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
  })
  afterAll(closeDb)

  it('uses the persisted event-id cursor for the next page request, not res.cursor', async () => {
    const first = decodedEvent('joined', { member: 'GA', fee: '10' }, { ledger: 600 })
    const second = decodedEvent('joined', { member: 'GB', fee: '20' }, { ledger: 601 })

    // First page: server returns a response cursor that differs from last.id.
    // This is exactly the divergence that caused issue #138.
    getEventsMock
      .mockResolvedValueOnce({
        events: [first],
        cursor: 'server-cursor-1',
        latestLedger: 100_000,
      })
      .mockResolvedValueOnce({
        events: [second],
        cursor: 'server-cursor-2',
        latestLedger: 100_000,
      })

    await fetchOnce('CTESTCONTRACT')

    // The second request must use first.id, not the server's response cursor.
    expect(getEventsMock).toHaveBeenCalledTimes(2)
    const secondCall = getEventsMock.mock.calls[1]![0] as { cursor: string }
    expect(secondCall.cursor).toBe(first.id)
  })
})

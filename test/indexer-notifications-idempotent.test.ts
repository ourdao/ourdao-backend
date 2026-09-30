// Issue #271: replaying an event wrote a second notification for the same
// contract action. The indexer replays deliberately (reorg recovery, worker
// restart, reindexFromEventLog), and the insert path had no conflict handling,
// so a member's inbox accumulated one duplicate per replay.
//
// The fix is two-part — a UNIQUE (event_id, address) index and an
// ON CONFLICT DO NOTHING insert — so these tests cover both the guarantee and
// the property that makes it usable: a replay is a silent no-op, and it does
// not clobber read state.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query } from '../src/db/index.js'
import { applyEvent } from '../src/indexer/handlers.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

const MEMBER = 'GBIU43K4ICLBGTVHSQJH7F37Y6R6IAGAGJJTNZGJV2GD4V3PD4DG42R3'

async function ingest(client: PoolClient, ev: DecodedEvent): Promise<void> {
  await client.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol,
     JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
  )
  await applyEvent(client, ev)
}

describe('notifications are idempotent under replay (#271)', () => {
  let client: PoolClient

  beforeEach(async () => {
    await resetDb()
    client = await pool.connect()
    // `joined` registers the member the later events notify.
    await ingest(client, decodedEvent('joined', { member: MEMBER, fee: '10' }))
  })
  afterAll(closeDb)

  it('a unique index enforces one row per (event_id, address)', async () => {
    // `loan_req` notifies the borrower (handlers.ts), so this is a real
    // notification-producing event rather than a bare derived-table write.
    const ev = decodedEvent('loan_req', { id: 1, borrower: MEMBER, amount: '5', total_repayment: '6' })
    await ingest(client, ev)

    const before = await query('SELECT id FROM notifications WHERE event_id = $1 AND address = $2', [ev.id, MEMBER])
    expect(before).toHaveLength(1)

    // The database itself must refuse a second row, independent of the insert
    // path — that is what the migration adds.
    await expect(
      client.query(
        `INSERT INTO notifications (address, type, title, message, ledger, event_id)
         VALUES ($1, 'info', 'dup', 'dup', 1, $2)`,
        [MEMBER, ev.id]
      )
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('re-applying the same loan_req event does not duplicate the notification', async () => {
    const ev = decodedEvent('loan_req', { id: 7, borrower: MEMBER, amount: '5', total_repayment: '6' })

    await ingest(client, ev)
    await applyEvent(client, ev)
    await applyEvent(client, ev)

    const rows = await query<{ event_id: string }>(
      'SELECT event_id FROM notifications WHERE event_id = $1 AND address = $2',
      [ev.id, MEMBER]
    )
    expect(rows).toHaveLength(1)
  })

  it('re-applying the same treasury execution event does not duplicate the notification', async () => {
    // `tre_exec` is the treasury path that notifies the destination.
    const ev = decodedEvent('tre_exec', { id: 3, amount: '1000', destination: MEMBER })

    await ingest(client, ev)
    await applyEvent(client, ev)

    const rows = await query<{ event_id: string }>(
      'SELECT event_id FROM notifications WHERE event_id = $1 AND address = $2',
      [ev.id, MEMBER]
    )
    expect(rows).toHaveLength(1)
  })

  it('a replay preserves the member having already read the notification', async () => {
    const ev = decodedEvent('loan_req', { id: 9, borrower: MEMBER, amount: '5', total_repayment: '6' })
    await ingest(client, ev)
    await client.query('UPDATE notifications SET read = true WHERE event_id = $1 AND address = $2', [ev.id, MEMBER])

    await applyEvent(client, ev)

    const rows = await query<{ read: boolean }>(
      'SELECT read FROM notifications WHERE event_id = $1 AND address = $2',
      [ev.id, MEMBER]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.read).toBe(true)
  })

  it('reindexFromEventLog reproduces the same notification set', async () => {
    // The end-to-end replay path: rebuild derived state from the raw log and
    // assert the inbox is unchanged, not merely non-empty.
    await ingest(client, decodedEvent('loan_req', { id: 11, borrower: MEMBER, amount: '5', total_repayment: '6' }))
    await ingest(client, decodedEvent('tre_exec', { id: 12, amount: '10', destination: MEMBER }))

    const snapshot = () =>
      query<{ address: string; title: string; ledger: number | null }>(
        'SELECT address, title, ledger FROM notifications ORDER BY address, title, ledger'
      )

    const before = await snapshot()
    expect(before).toHaveLength(3) // joined + loan_req + tre_exec

    await reindexFromEventLog()

    expect(await snapshot()).toEqual(before)
  })

  it('distinct events still produce distinct notifications', async () => {
    // Guards against over-correcting: dedupe must key on the event, not the
    // recipient or the message.
    await ingest(client, decodedEvent('loan_req', { id: 21, borrower: MEMBER, amount: '5', total_repayment: '6' }))
    await ingest(client, decodedEvent('loan_req', { id: 22, borrower: MEMBER, amount: '6', total_repayment: '7' }))

    const rows = await query<{ event_id: string }>(
      `SELECT event_id FROM notifications
        WHERE address = $1 AND title = 'Loan requested'
        ORDER BY event_id`,
      [MEMBER]
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(2)
  })
})

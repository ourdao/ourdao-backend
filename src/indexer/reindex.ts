import type { PoolClient } from 'pg'
import { pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'

interface EventLogRow {
  id: string
  ledger: number
  closed_at: Date | string
  contract_id: string
  symbol: string
  topics: unknown
  data: unknown
  tx_hash: string | null
}

/**
 * Rebuild every derived table from the raw `events` log (issue #23).
 *
 * The incremental fold the indexer runs and a full rebuild from the log must
 * produce byte-identical derived state — that property is what makes the raw
 * log authoritative and makes re-indexing a real recovery mechanism: for a
 * detected ledger discontinuity, and for the historical-data bugs tracked in
 * other issues in this repo (rejoin double-counting, missing default
 * penalties, unweighted tallies) which this command repairs in one pass.
 *
 * Runs in a single transaction — the whole rebuild lands or none of it does.
 */
export async function reindexFromEventLog(): Promise<{ events: number }> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    // Issue #52: preserve user-authored notification read states across rebuilds
    const { rows: savedReads } = await client.query<{ event_id: string; address: string }>(
      `SELECT event_id, address FROM notifications WHERE read = true AND event_id IS NOT NULL`
    )

    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    await resetDaoTotals(client)

    const { rows } = await client.query<EventLogRow>(
      `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
         FROM events ORDER BY ledger ASC, id ASC`
    )

    for (const row of rows) {
      const data = Array.isArray(row.data) ? (row.data as unknown[]) : [row.data]
      const ev: DecodedEvent = {
        id: row.id,
        ledger: row.ledger,
        closedAt:
          row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at),
        contractId: row.contract_id,
        txHash: row.tx_hash,
        symbol: row.symbol,
        topics: Array.isArray(row.topics) ? (row.topics as unknown[]) : [],
        data,
        fields: namedFields(row.symbol, data),
      }
      await applyEvent(client, ev)
    }

    if (savedReads.length > 0) {
      for (const item of savedReads) {
        await client.query(
          `UPDATE notifications SET read = true WHERE event_id = $1 AND address = $2`,
          [item.event_id, item.address]
        )
      }
    }

    await client.query('COMMIT')
    return { events: rows.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// `npm run reindex`
if (import.meta.url === `file://${process.argv[1]}`) {
  reindexFromEventLog()
    .then(({ events }) => {
      console.log(`[reindex] rebuilt derived tables from ${events} event(s)`)
      return pool.end()
    })
    .catch((err) => {
      console.error('[reindex] failed:', err)
      process.exit(1)
    })
}
/* v8 ignore stop */

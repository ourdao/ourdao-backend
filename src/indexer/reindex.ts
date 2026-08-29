import type { PoolClient } from 'pg'
import { pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'

// Arbitrary fixed key for a session-level advisory lock, distinct from
// MIGRATION_LOCK_KEY (0x0d40_0000). The indexer worker and reindex command
// share this lock to ensure a reindex never races a live worker folding events.
export const REINDEX_LOCK_KEY = 0x0d40_0001

export class ReindexLockError extends Error {
  constructor(
    message = 'Cannot acquire reindex advisory lock (0x0d400001). Another reindex is in progress or the indexer worker is currently folding events. Stop the indexer worker before running reindex.'
  ) {
    super(message)
    this.name = 'ReindexLockError'
  }
}

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

export interface ReindexOptions {
  batchSize?: number
  progressIntervalMs?: number
}

/**
 * Rebuild every derived table from the raw `events` log (issues #23, #50).
 *
 * The incremental fold the indexer runs and a full rebuild from the log must
 * produce byte-identical derived state — that property is what makes the raw
 * log authoritative and makes re-indexing a real recovery mechanism: for a
 * detected ledger discontinuity, and for historical-data repairs.
 *
 * Runs in a single transaction — the whole rebuild lands or none of it does.
 * Memory usage is bounded via keyset pagination over (ledger, id) so large
 * event logs can be reindexed without buffering the full dataset in Node memory.
 * Serialized across concurrent reindex/worker operations with a Postgres advisory lock.
 */
export async function reindexFromEventLog(options?: ReindexOptions): Promise<{ events: number }> {
  const client: PoolClient = await pool.connect()
  let lockAcquired = false

  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new ReindexLockError()
    }
    lockAcquired = true

    await client.query('BEGIN')
    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    await resetDaoTotals(client)

    const totalRes = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM events')
    const totalEvents = Number.parseInt(totalRes.rows[0]?.count ?? '0', 10)

    const batchSize = Math.max(1, options?.batchSize ?? 1000)
    const progressIntervalMs = options?.progressIntervalMs ?? 2000
    let processed = 0
    let lastLedger: number | null = null
    let lastId: string | null = null
    const startTime = Date.now()
    let lastLogTime = startTime

    while (true) {
      let queryText: string
      let params: unknown[]

      if (lastLedger === null || lastId === null) {
        queryText = `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
                       FROM events
                      ORDER BY ledger ASC, id ASC
                      LIMIT $1`
        params = [batchSize]
      } else {
        queryText = `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
                       FROM events
                      WHERE ledger > $1 OR (ledger = $1 AND id > $2)
                      ORDER BY ledger ASC, id ASC
                      LIMIT $3`
        params = [lastLedger, lastId, batchSize]
      }

      const { rows } = await client.query<EventLogRow>(queryText, params)
      if (rows.length === 0) break

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
        processed += 1
        lastLedger = row.ledger
        lastId = row.id
      }

      const now = Date.now()
      if (totalEvents > 0 && (now - lastLogTime >= progressIntervalMs || processed === totalEvents)) {
        const elapsedSec = (now - startTime) / 1000
        const rate = elapsedSec > 0 ? (processed / elapsedSec).toFixed(1) : '0'
        const pct = ((processed / totalEvents) * 100).toFixed(1)
        const remaining = totalEvents - processed
        const etaSec = elapsedSec > 0 && processed > 0 ? Math.round(remaining / (processed / elapsedSec)) : 0
        console.log(
          `[reindex] progress: ${processed}/${totalEvents} event(s) (${pct}%) up to ledger ${lastLedger ?? 0} — ` +
            `${rate} ev/s, elapsed ${elapsedSec.toFixed(1)}s, ETA ${etaSec}s`
        )
        lastLogTime = now
      }
    }

    await client.query('COMMIT')
    return { events: processed }
  } catch (err) {
    if (lockAcquired) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Rollback failure ignored
      }
    }
    throw err
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [REINDEX_LOCK_KEY])
      } catch (err) {
        console.error('[reindex] failed to release advisory lock:', err)
      }
    }
    client.release()
  }
}

// `npm run reindex`
/* v8 ignore start -- run-directly entrypoint, exercised as a subprocess not by vitest (#79) */
if (import.meta.url === `file://${process.argv[1]}`) {
  const handleSigint = () => {
    console.log('\n[reindex] interrupted by SIGINT — releasing resources and exiting')
    process.exit(130)
  }
  process.once('SIGINT', handleSigint)

  reindexFromEventLog()
    .then(({ events }) => {
      console.log(`[reindex] rebuilt derived tables from ${events} event(s)`)
      return pool.end()
    })
    .catch((err) => {
      console.error('[reindex] failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
/* v8 ignore stop */

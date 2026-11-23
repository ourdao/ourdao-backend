import type { PoolClient } from 'pg'
import { exemptTransactionFromStatementTimeout, pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'
import { reindexRunsCounter, reindexDurationHistogram } from '../api/metrics.js'
import { logger } from '../lib/logger.js'

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
 *
 * Issue #529: Increments ourdao_reindex_runs_total counter and observes
 * ourdao_reindex_duration_seconds histogram on completion.
 */
export async function reindexFromEventLog(): Promise<{ events: number }> {
  const startTime = Date.now()
  const client: PoolClient = await pool.connect()
  let lockAcquired = false
  let processed = 0
  // Issue #169: channels touched by this rebuild, notified once after
  // COMMIT rather than per-event on `client` — a historical replay of
  // potentially the whole event log has no business sending one NOTIFY per
  // event, and doing so on the transaction's own connection risks the same
  // "failure poisons the transaction" problem the live fold path had.
  const touchedChannels = new Set<StreamChannel>()

  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext(current_schema()))',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new ReindexLockError()
    }
    lockAcquired = true

    await client.query('BEGIN')
    // Issue #196: the pool applies a default statement_timeout; a rebuild of
    // the whole event log is expected to run far longer. Exempt this
    // transaction only (SET LOCAL reverts at COMMIT/ROLLBACK).
    await exemptTransactionFromStatementTimeout(client, 'ourdao-reindex')
    // Issue #52: preserve user-authored notification read states across rebuilds
    const { rows: savedReads } = await client.query<{ event_id: string; address: string }>(
      `SELECT event_id, address FROM notifications WHERE read = true AND event_id IS NOT NULL`
    )

    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    await resetDaoTotals(client)

    const totalRes = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM events')
    const totalEvents = Number.parseInt(totalRes.rows[0]?.count ?? '0', 10)

    // Issue #531: report progress as structured JSON, one line per 10% (and
    // the final event). `msg` keeps the human-readable text an operator
    // watching a terminal saw before; the fields make it queryable.
    const total = rows.length
    const progressEvery = Math.max(1, Math.ceil(total / 10))

    for (const [index, row] of rows.entries()) {
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

      const processed = index + 1
      if (processed % progressEvery === 0 || processed === total) {
        const elapsedSec = (Date.now() - startTime) / 1000
        const ratePerSec = elapsedSec > 0 ? processed / elapsedSec : 0
        const etaSec = ratePerSec > 0 ? Math.ceil((total - processed) / ratePerSec) : 0
        const pct = total > 0 ? (processed / total) * 100 : 100
        logger.info(
          `[reindex] progress: ${processed}/${total} event(s) (${pct.toFixed(2)}%) — ` +
            `${ratePerSec.toFixed(1)} events/s, eta ${etaSec}s`,
          { processed, total, pct, ratePerSec, etaSec }
        )
      }
    }

    // Issue #168, #395: a reindex re-applies every raw event through the same
    // `applyEvent` a previously-quarantined event failed in. If we got this
    // far, every event in the log — including any that's already recorded
    // in `failed_events` — just folded without throwing, in this same
    // transaction. So any record still unresolved is, as of this commit,
    // repaired: mark it rather than delete it, so the failure history (what
    // failed and why) survives, but stop counting it as a live problem.
    // Set resolution = 'resolved' alongside resolved_at = now() (issue #395).
    await client.query(`UPDATE failed_events SET resolved_at = now(), resolution = 'resolved' WHERE resolved_at IS NULL`)

    // Issue #191: a completed rebuild is the recovery from a detected
    // discontinuity, so clear the recorded halt in the same transaction —
    // the worker may resume as soon as this commits, and not before.
    await client.query(
      `UPDATE reorg_halts SET cleared_at = now(), cleared_by = 'reindex' WHERE cleared_at IS NULL`
    )

    await client.query('COMMIT')
    
    // Issue #529: record metrics on successful completion
    const durationSeconds = (Date.now() - startTime) / 1000
    reindexRunsCounter.inc()
    reindexDurationHistogram.observe(durationSeconds)
    
    return { events: rows.length }
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
        await client.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [REINDEX_LOCK_KEY])
      } catch (err) {
        console.error('[reindex] failed to release advisory lock:', err)
      }
    }
    client.release()
  }

  // The rebuild committed — send the deferred NOTIFYs now that every
  // derived-table write is durable, each on its own connection from the
  // shared pool (issue #169), never on the reindex transaction's own client.
  for (const channel of touchedChannels) {
    await notifyStreamClientsAfterCommit(channel, { symbol: 'reindex', timestamp: Date.now() })
  }

  const historyCache = createHistoryCache()
  await historyCache.invalidate()

  return { events: processed }
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
      logger.info(`[reindex] rebuilt derived tables from ${events} event(s)`, { events })
      return pool.end()
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[reindex] failed: ${message}`, { error: message })
      process.exit(1)
    })
}
/* v8 ignore stop */

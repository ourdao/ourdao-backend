import type { PoolClient } from 'pg'
import { pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { markFolded } from './poller.js'
import { REINDEX_LOCK_KEY } from './reindex.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'
import { notifyStreamClientsAfterCommit, type StreamChannel } from '../api/stream.js'
import { logger } from '../logger.js'

/**
 * Targeted recovery for a quarantined event (issue #170) — the middle
 * ground between "leave it" and `npm run reindex`, which rebuilds every
 * derived table from the entire raw log regardless of how many events
 * actually need it.
 *
 * A quarantined event's raw row already exists in `events` (the quarantine
 * path in poller.ts writes it unconditionally); what didn't happen is the
 * fold. This module re-attempts exactly that fold, for exactly the raw
 * event(s) `failed_events` still lists as unresolved, each in its own
 * transaction, under the same `REINDEX_LOCK_KEY` advisory lock the poller
 * and reindex both take — so a replay can never race a live worker folding
 * events, or a concurrent reindex.
 */

export class ReplayLockError extends Error {
  // Issue #283: src/api/errors.ts's classifyError treats a thrown error with
  // an explicit 4xx statusCode as "chosen on purpose" and keeps its message
  // verbatim in the response — so the HTTP re-evaluate endpoint needs no
  // separate try/catch to map this to 409, it just propagates.
  readonly statusCode = 409

  constructor(eventId: string) {
    super(
      `Cannot replay event ${eventId}: reindex or the live indexer worker is currently folding events ` +
        `(advisory lock 0x0d400001 held). Stop the indexer worker (or wait for the reindex to finish) and retry.`
    )
    this.name = 'ReplayLockError'
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
  folded_at: string | null
}

function toDecodedEvent(row: EventLogRow): DecodedEvent {
  const data = Array.isArray(row.data) ? (row.data as unknown[]) : [row.data]
  return {
    id: row.id,
    ledger: row.ledger,
    closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at),
    contractId: row.contract_id,
    txHash: row.tx_hash,
    symbol: row.symbol,
    topics: Array.isArray(row.topics) ? (row.topics as unknown[]) : [],
    data,
    fields: namedFields(row.symbol, data),
  }
}

export type ReplayOutcome =
  | { eventId: string; status: 'replayed' }
  | { eventId: string; status: 'already_resolved' }
  | { eventId: string; status: 'still_failing'; error: string }

/**
 * Re-fold exactly one event by its raw `events.id`, and mark its
 * `failed_events` record(s) resolved on success.
 *
 * Idempotent (task requirement): if the row is already folded (`folded_at`
 * is set — an earlier replay attempt, or the live poller having since
 * caught up on it some other way) this only updates the bookkeeping and
 * never re-applies the fold, so a re-run can't double-count. If it's still
 * unresolved and still throws, the existing `failed_events` row(s) for this
 * event id are updated in place with the new error — never a new row
 * inserted — so retrying a still-broken handler doesn't inflate the
 * quarantine count.
 */
export async function replayFailedEvent(eventId: string): Promise<ReplayOutcome> {
  const client: PoolClient = await pool.connect()
  let lockAcquired = false
  let notifyChannel: StreamChannel | undefined

  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext(current_schema()))',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new ReplayLockError(eventId)
    }
    lockAcquired = true

    const unresolvedRes = await client.query<{ id: number }>(
      `SELECT id FROM failed_events WHERE event_id = $1 AND resolved_at IS NULL`,
      [eventId]
    )
    if (unresolvedRes.rows.length === 0) {
      return { eventId, status: 'already_resolved' }
    }

    const eventRes = await client.query<EventLogRow>(
      `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash, folded_at
         FROM events WHERE id = $1`,
      [eventId]
    )
    const row = eventRes.rows[0]
    if (!row) {
      throw new Error(
        `event ${eventId} has an unresolved failed_events record but no matching row in events — data inconsistency, investigate manually`
      )
    }

    if (row.folded_at != null) {
      // Already folded — by an earlier replay attempt, or the poller having
      // since re-processed it some other way. Nothing to re-apply; just
      // catch the bookkeeping up (issue #119's folded_at is the source of
      // truth for "needs folding", not the failed_events row).
      await client.query(
        `UPDATE failed_events SET resolved_at = now() WHERE event_id = $1 AND resolved_at IS NULL`,
        [eventId]
      )
      return { eventId, status: 'already_resolved' }
    }

    const ev = toDecodedEvent(row)

    try {
      await client.query('BEGIN')
      const channel = await applyEvent(client, ev)
      await markFolded(client, ev.id)
      await client.query(
        `UPDATE failed_events SET resolved_at = now() WHERE event_id = $1 AND resolved_at IS NULL`,
        [eventId]
      )
      await client.query('COMMIT')
      notifyChannel = channel
    } catch (err) {
      await client.query('ROLLBACK')
      const message = err instanceof Error ? err.message : String(err)
      // Update the existing record(s) rather than inserting a new one — a
      // still-broken handler must not double-count the same event as two
      // separate quarantine entries.
      await client.query(
        `UPDATE failed_events SET error = $2 WHERE event_id = $1 AND resolved_at IS NULL`,
        [eventId, message]
      )
      logger.error('replay: event still fails to fold', { eventId, symbol: row.symbol, error: message })
      return { eventId, status: 'still_failing', error: message }
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [REINDEX_LOCK_KEY])
      } catch (err) {
        logger.error('replay: failed to release advisory lock', {
          eventId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    client.release()
  }

  if (notifyChannel) {
    await notifyStreamClientsAfterCommit(notifyChannel, { symbol: 'replay', timestamp: Date.now() })
  }
  return { eventId, status: 'replayed' }
}

/** Replay every currently-unresolved quarantined event, one at a time. A
 *  handler still broken for one event doesn't stop the rest — each id gets
 *  its own outcome. */
export async function replayAllUnresolvedFailedEvents(): Promise<ReplayOutcome[]> {
  const { rows } = await pool.query<{ event_id: string }>(
    `SELECT DISTINCT event_id FROM failed_events WHERE resolved_at IS NULL ORDER BY event_id`
  )
  const outcomes: ReplayOutcome[] = []
  for (const row of rows) {
    outcomes.push(await replayFailedEvent(row.event_id))
  }
  return outcomes
}

// `npm run replay-failed` — replay a single event with `--id <event_id>`,
// or every unresolved one with no arguments.
/* v8 ignore start -- run-directly entrypoint, exercised as a subprocess not by vitest (#79) */
if (import.meta.url === `file://${process.argv[1]}`) {
  const idFlagIndex = process.argv.indexOf('--id')
  const singleEventId = idFlagIndex !== -1 ? process.argv[idFlagIndex + 1] : undefined

  const handleSigint = () => {
    console.log('\n[replay] interrupted by SIGINT')
    process.exit(130)
  }
  process.once('SIGINT', handleSigint)

  const run = singleEventId
    ? replayFailedEvent(singleEventId).then((outcome) => [outcome])
    : replayAllUnresolvedFailedEvents()

  run
    .then((outcomes) => {
      for (const outcome of outcomes) {
        console.log(`[replay] ${outcome.eventId}: ${outcome.status}${outcome.status === 'still_failing' ? ` — ${outcome.error}` : ''}`)
      }
      const stillFailing = outcomes.filter((o) => o.status === 'still_failing').length
      console.log(
        `[replay] done — ${outcomes.length} event(s) processed, ${stillFailing} still failing`
      )
      return pool.end()
    })
    .catch((err) => {
      console.error('[replay] failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
/* v8 ignore stop */

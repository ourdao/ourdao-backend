import type { rpc } from '@stellar/stellar-sdk'
import type { PoolClient } from 'pg'
import { SpanStatusCode } from '@opentelemetry/api'
import { config, assertContractsConfigured } from '../config.js'
import { pool, query, queryOne } from '../db/index.js'
import { server, getLatestLedger, getLatestLedgerInfo, getLedgerHash } from '../stellar/rpc.js'
import { decodeEvent, type DecodedEvent } from '../stellar/events.js'
import { applyEvent } from './handlers.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'
import { REINDEX_LOCK_KEY } from './reindex.js'
import { notifyStreamClientsAfterCommit, STREAM_CHANNELS, type StreamChannel } from '../api/stream.js'
import { invalidateCache, invalidateMembersListCache, memberSummaryCacheKey } from '../cache/redis.js'
import { getTracer } from '../telemetry.js'

interface CursorRow {
  paging_token: string | null
  last_ledger: number | null
  last_ledger_hash: string | null
  // RPC-observed chain tip, distinct from `last_ledger` (issue #45) — see
  // the comment on the `documents`/schema migration and fetchOnce below.
  observed_tip_ledger: number | null
  contract_id: string | null
}

// Per-run abort controller — replaced on each runIndexer() call so the flag
// doesn't persist across runs (issue #48). An AbortController also gives the
// drain loop (issue #47) a way to check for shutdown between pages.
let abortController: AbortController | null = null
let running = false

/** Thrown when the ledger sequence the indexer sees stops being monotonic —
 *  the RPC's reported tip fell below our cursor, or a fetched page contains
 *  an event from a ledger we already advanced past. It means history diverged
 *  from what we folded (issue #23). The poll loop halts on this rather than
 *  retrying; an operator re-indexes from the raw log (`npm run reindex`)
 *  after confirming the true chain state. */
export class ReorgDetectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReorgDetectedError'
  }
}

/** Thrown by `runIndexer` when a recorded discontinuity has not been cleared
 *  (issue #191): the worker refuses to start rather than fold past diverged
 *  history on an automatic restart. */
export class ReorgHaltedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReorgHaltedError'
  }
}

/** One recorded ledger discontinuity (issue #191). */
export interface ReorgHalt {
  id: number
  contract_id: string
  last_ledger: number | null
  last_ledger_hash: string | null
  detail: string
  detected_at: string
  cleared_at: string | null
  cleared_by: string | null
}

/** Persist a detected discontinuity before the worker exits, so the halt is
 *  visible over the API after the process (and its logs) are gone. Best
 *  effort: a failure to record must not mask the halt itself, so it is logged
 *  and swallowed — the worker still exits non-zero either way. */
export async function recordReorgHalt(contractId: string, err: ReorgDetectedError): Promise<void> {
  try {
    const cursor = await loadCursor(contractId)
    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ($1, $2, $3, $4)`,
      [contractId, cursor?.last_ledger ?? null, cursor?.last_ledger_hash ?? null, err.message]
    )
  } catch (recordErr) {
    console.error('[indexer] failed to record the ledger discontinuity:', recordErr)
  }
}

/** The most recent discontinuity no operator has cleared, or null. */
export async function loadUnclearedReorgHalt(): Promise<ReorgHalt | null> {
  return queryOne<ReorgHalt>(
    `SELECT id, contract_id, last_ledger, last_ledger_hash, detail, detected_at, cleared_at, cleared_by
       FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1`
  )
}

/** Mark every uncleared discontinuity as cleared by `clearedBy` (`reindex`
 *  when a rebuild completed, or the operator acknowledging a false alarm via
 *  `npm run reorg:clear`). Returns how many rows were cleared. */
export async function clearReorgHalts(clearedBy: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE reorg_halts SET cleared_at = now(), cleared_by = $1 WHERE cleared_at IS NULL RETURNING id`,
    [clearedBy]
  )
  return rows.length
}

/** Wipe the cursor and every derived table so the indexer can re-index a new
 *  deployment from an empty slate. Destructive — only reached when
 *  INDEXER_RESET_ON_CONTRACT_CHANGE is set. */
export async function resetForContractChange(): Promise<void> {
  const client = await pool.connect()
  try {
    // Use pg_try_advisory_xact_lock so we fail fast if the lock is already
    // held (e.g. a reindex or fold is in progress). pg_advisory_xact_lock
    // blocks indefinitely; pg_try_advisory_xact_lock returns false immediately.
    // The lock is transaction-scoped so it releases automatically on COMMIT
    // or ROLLBACK — no explicit unlock is needed, preventing leaks on crash.
    await client.query('BEGIN')
    const lockRes = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1, hashtext(current_schema()))',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_xact_lock) {
      throw new Error(
        'Cannot reset database for contract change: reindex or fold operation is currently in progress (advisory lock held)'
      )
    }

    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    await resetDaoTotals(client)
    // Issue #289: wipes every tailed contract's cursor row, not just one —
    // a reset re-indexes everything from scratch, all contracts included.
    await client.query('DELETE FROM indexer_cursor')
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Rollback failure ignored
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Guard against silently merging two deployments' state (issue #16). The
 * OurDAO contract has no upgrade path, so every fix is a fresh deployment
 * with a new CONTRACT_ID — and proposal/loan ids restart at 0, so the new
 * contract's rows would collide with the old one's under `ON CONFLICT (id)
 * DO UPDATE`.
 *
 * If the saved cursor was last advanced for a different contract, refuse to
 * start with an actionable error. Setting INDEXER_RESET_ON_CONTRACT_CHANGE
 * instead wipes the cursor + derived tables and re-indexes from scratch.
 * No-op when the cursor is absent or already matches.
 */
export async function ensureCursorContract(contractIds: string[]): Promise<void> {
  const rows = await query<{ contract_id: string }>('SELECT contract_id FROM indexer_cursor')
  const configured = new Set(contractIds)
  // Issue #289: cursor rows are now keyed by contract_id (one per tailed
  // contract), so there's no longer a single "the" saved contract to compare
  // against — instead, any row whose contract_id isn't in the currently
  // configured set means that contract was removed/replaced (a redeploy —
  // the DAO contract has no upgrade path, see #16) since the last run, and
  // its derived state must not silently keep being treated as live.
  const stale = rows.filter((r) => !configured.has(r.contract_id)).map((r) => r.contract_id)
  if (stale.length === 0) return

  if (config.indexer.resetOnContractChange) {
    console.warn(
      `[indexer] configured contract(s) changed (stale: ${stale.join(', ')}; now: ${contractIds.join(', ')}) and ` +
        `INDEXER_RESET_ON_CONTRACT_CHANGE is set: wiping the cursor, derived ` +
        `tables (${DERIVED_TABLES.join(', ')}), and dao_totals — re-indexing from scratch. ` +
        `The raw events log is left intact.`
    )
    await resetForContractChange()
    return
  }

  throw new Error(
    `Indexer cursor has row(s) for contract(s) no longer configured: ${stale.join(', ')} ` +
      `(configured: ${contractIds.join(', ')}). Resuming would merge a stale deployment's derived ` +
      `state with a new one. To repoint at a new deployment: start once with ` +
      `INDEXER_RESET_ON_CONTRACT_CHANGE=true to wipe the cursor and derived tables, or point ` +
      `DATABASE_URL at a fresh database. See the README's "Redeploying the contract" section.`
  )
}

/** Loads the saved cursor for `contractId`, or null if this contract has
 *  never been polled before (cold start). */
async function loadCursor(contractId: string): Promise<CursorRow | null> {
  return queryOne<CursorRow>(
    'SELECT paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, contract_id FROM indexer_cursor WHERE contract_id = $1',
    [contractId]
  )
}

// Issue #173: saveCursor can fail on its own after folding succeeds. Track
// these failures separately so the poll loop can distinguish:
// 1. A transient saveCursor write failure (should be retried) — doesn't mean
//    folding failed, just that persistence didn't complete
// 2. A stalled indexer (the fold succeeded but the cursor wasn't persisted
//    and later restarts/failures happen) — detected by examining cursor
//    staleness vs actual folder progress
//
// Correctness holds today because folding is keyed on event id and is
// idempotent. A cursor write failure followed by a crash leaves the fold
// committed but the cursor behind; on restart the page is refetched but
// events aren't re-applied (insertRawEvent's folded_at check — issue #119).
// The issue is that /ready reports stale from an unchanging updated_at even
// though events are being folded correctly. This tracking lets us distinguish
// that case from a genuinely stalled indexer.
async function saveCursor(
  contractId: string,
  pagingToken: string | null,
  lastLedger: number,
  observedTipLedger: number,
  lastLedgerHash: string | null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO indexer_cursor (paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, contract_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (contract_id) DO UPDATE SET paging_token = $1, last_ledger = $2, last_ledger_hash = $3, observed_tip_ledger = $4, updated_at = now()`,
      [pagingToken, lastLedger, lastLedgerHash, observedTipLedger, contractId]
    )
    // Clear any prior cursor write failure now that this one succeeded
    cursorWriteFailures = null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    cursorWriteFailures = { error: msg, at: Date.now() }
    // Re-throw: the poll loop needs to know folding didn't complete
    // (the fold itself succeeded, but its progress wasn't recorded).
    throw new Error(`Cursor write failed: ${msg}`, { cause: err })
  }
}

/** Touch updated_at without changing data — keeps freshness signal alive on idle contracts. */
async function touchCursor(contractId: string): Promise<void> {
  await pool.query('UPDATE indexer_cursor SET updated_at = now() WHERE contract_id = $1', [contractId])
}

/** Determine the ledger to start from on a cold start (no saved cursor). */
async function resolveStartLedger(): Promise<number> {
  if (config.indexer.startLedger > 0) return config.indexer.startLedger
  const latest = await getLatestLedger()
  return Math.max(1, latest - config.indexer.startLookbackLedgers)
}

/** Insert one event's raw log row (idempotent on its unique id) and report
 *  whether it still needs folding — i.e. `folded_at IS NULL` on the row that
 *  now exists, regardless of whether *this* call did the inserting.
 *
 *  Fold completion is tracked independently of raw-row existence (issue
 *  #119): the quarantine path commits this insert on its own, separately
 *  from the fold that follows, so a crash in between leaves a raw row with
 *  no fold. Keying "needs fold" off the row's own `folded_at` (rather than
 *  off whether this INSERT was the one that created the row) means that on
 *  retry the row is found to still need folding instead of being skipped.
 *
 *  Shared by the whole-page path and the per-event quarantine path (issue
 *  #43) so both write the same row the same way. */
/** Issue #277: invalidate the read-through caches that `applyEvent`'s fold
 *  just made stale, once (and only once) its transaction has actually
 *  committed — same "after commit, on a separate connection" discipline as
 *  `notifyStreamClientsAfterCommit` right below each call site, and for the
 *  same reason: a cache write must never ride on, or be able to poison, the
 *  fold transaction's own connection. Only `STREAM_CHANNELS.members` events
 *  (joined/exited/staked/unstaked/claimed — see channelMap in handlers.ts)
 *  actually touch cached member state, so every other channel is a no-op
 *  here. Every one of those handlers keys off an address field named
 *  `member` (see requireAddr(ev, 'member') in handlers.ts) — if that field
 *  is somehow missing the members-list cache is still invalidated, just not
 *  the (unknown) per-address summary key. A cache failure here is swallowed
 *  by invalidateCache/invalidateMembersListCache themselves — it can only
 *  ever cost an extra `MEMBER_CACHE_TTL_SECONDS` of staleness, never crash
 *  the indexer. */
async function invalidateMemberCachesAfterCommit(channel: StreamChannel | undefined, ev: DecodedEvent): Promise<void> {
  if (channel !== STREAM_CHANNELS.members) return
  await invalidateMembersListCache()
  const address = ev.fields?.member
  if (typeof address === 'string' && address) {
    await invalidateCache(memberSummaryCacheKey(address))
  }
}

async function insertRawEvent(client: PoolClient, ev: DecodedEvent): Promise<boolean> {
  const res = await client.query<{ folded_at: string | null }>(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash, decode_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET id = events.id
     RETURNING folded_at`,
    [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol, JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash, ev.decodeError ?? null]
  )
  return res.rows[0]?.folded_at == null
}

/** Mark an event's row as folded — set in the same transaction as the fold
 *  itself so `folded_at` is never non-null for a fold that didn't commit
 *  (issue #119). Exported for src/indexer/replay.ts (issue #170), which
 *  folds a single previously-quarantined event the same way. */
export async function markFolded(client: PoolClient, id: string): Promise<void> {
  await client.query('UPDATE events SET folded_at = now() WHERE id = $1', [id])
}

/** Persist a page of events + their derived side effects atomically.
 *  `lastLedger` is the highest ledger already folded — used for the
 *  continuity check (issue #23). Whole-page-transaction is the fast path:
 *  it's what runs on every normal poll. When a page can't be folded this way
 *  — one event's handler throws deterministically — the caller
 *  (`ingestPageWithQuarantine`) falls back to folding one event per
 *  transaction so the rest of the page isn't held hostage (issue #43). */
async function ingestPage(events: rpc.Api.EventResponse[], lastLedger: number): Promise<void> {
  if (events.length === 0) return
  const client = await pool.connect()
  let lockAcquired = false
  // Issue #169: channels to NOTIFY once this page's transaction has
  // committed — collected during the fold instead of notifying inline on
  // `client`, so a NOTIFY failure can never affect (or be masked by) the
  // fold transaction itself. Sent after `finally` below releases the lock,
  // once we know COMMIT actually succeeded.
  const pendingNotifications: { channel: StreamChannel; ev: DecodedEvent }[] = []
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext(current_schema()))',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new Error(
        'Cannot ingest events: reindex is currently in progress (advisory lock held)'
      )
    }
    lockAcquired = true

    await client.query('BEGIN')
    for (const raw of events) {
      const ev = decodeEvent(raw)
      // Continuity check (issue #23): getEvents returns events in ascending
      // ledger order and we resume from a paging token, so a fetched event
      // from *below* the ledger we already folded past means history diverged
      // from what was applied. Halt rather than fold from a diverged chain.
      if (typeof ev.ledger === 'number' && lastLedger > 0 && ev.ledger < lastLedger) {
        throw new ReorgDetectedError(
          `event ${ev.id} is from ledger ${ev.ledger}, below the last folded ledger ${lastLedger}`
        )
      }
      // Raw log first (idempotent on the unique event id), then derived state.
      const needsFold = await insertRawEvent(client, ev)
      // Fold only on first sight of an event id. A re-delivered page then
      // can't re-apply increments (issue #24, and the vote-tally hazard) —
      // raw insert, fold, and the folded_at update are all in one
      // transaction here, so needsFold accurately reflects "not yet folded"
      // (issue #119).
      if (needsFold) {
        const channel = await applyEvent(client, ev)
        if (channel) pendingNotifications.push({ channel, ev })
        await markFolded(client, ev.id)
      }
    }
    await client.query('COMMIT')
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
        console.error('[indexer] failed to release advisory lock:', err)
      }
    }
    client.release()
  }

  // The transaction committed — send the deferred NOTIFYs now, each on its
  // own connection from the shared pool (issue #169). A failure here is
  // logged and counted by notifyStreamClientsAfterCommit itself; it cannot
  // roll back or otherwise affect the fold, which is already durable.
  for (const { channel, ev } of pendingNotifications) {
    await invalidateMemberCachesAfterCommit(channel, ev)
    await notifyStreamClientsAfterCommit(channel, {
      symbol: ev.symbol,
      ledger: ev.ledger,
      timestamp: Date.now(),
    })
  }
}

// Issue #173: saveCursor can fail after a page is folded, presenting as a
// stalled indexer even though events are being ingested. Track cursor writes
// separately so transient write failures don't wedge progress reporting.
let cursorWriteFailures: { error: string; at: number } | null = null

/** Issue #173: Get the last cursor write failure, if any. Used for diagnostics
 *  to distinguish between a stalled indexer (fold succeeded, cursor write failed)
 *  and genuine staleness (nothing is being folded).
 */
export function getCursorWriteFailures(): { error: string; at: number } | null {
  return cursorWriteFailures
}

async function recordQuarantinedEvent(ev: DecodedEvent, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  // Issue #171: fold failures of the same event into one row via UNIQUE constraint.
  // ON CONFLICT updates the row so the latest error message is recorded.
  try {
    await pool.query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (event_id) DO UPDATE SET error = $4, created_at = now()`,
      [ev.id, ev.symbol, ev.ledger, message]
    )
  } catch (insertErr) {
    throw new Error(
      `Failed to record quarantined event ${ev.id} in failed_events: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`,
      { cause: insertErr }
    )
  }
  console.error(`[indexer] quarantined event ${ev.id} (${ev.symbol}) at ledger ${ev.ledger}: ${message}`)
}

/** Record a quarantined event, tolerating a failure of the bookkeeping
 *  insert itself (issue #120). Without this guard, an error here — a
 *  constraint violation, disk full, a dropped connection — propagates out of
 *  `ingestEventQuarantined`, aborting the `for` loop in
 *  `ingestPageWithQuarantine` before it reaches any later event in the page
 *  and before it resets `quarantineState`. The page is retried from the top
 *  on the next poll, so nothing is stranded (`insertRawEvent`'s `folded_at`
 *  check — issue #119 — still sees this event as needing a fold), but every
 *  event after the one that hit the bookkeeping failure sits unfolded for
 *  an extra pass, and the failure itself would otherwise go unlogged.
 *
 *  Swallowing it here instead lets the loop finish the rest of the page and
 *  logs the failure loudly, so it isn't silent. */
async function recordQuarantinedEventSafely(ev: DecodedEvent, error: unknown): Promise<void> {
  try {
    await recordQuarantinedEvent(ev, error)
  } catch (recordErr) {
    const recordMsg = recordErr instanceof Error ? recordErr.message : String(recordErr)
    console.error(
      `[indexer] failed to record quarantined event ${ev.id} (${ev.symbol}) in failed_events — ` +
        `it was NOT folded and will be retried next pass: ${recordMsg}`
    )
  }
}

/** Fold exactly one event, each side in its own transaction (issue #43):
 *  the raw log insert commits on its own, so it survives untouched even if
 *  folding fails below — the append-only `events` row is never rolled back
 *  along with a broken fold. If applying the event throws, that one
 *  transaction rolls back (no partial derived-table writes) and the event is
 *  recorded in `failed_events` instead — the rest of the page's events are
 *  unaffected, and the cursor still advances past this one. A ReorgDetectedError
 *  is never caught here; it propagates so the indexer still halts on a
 *  genuine rewind.
 *
 *  Because the raw insert and the fold commit separately, a crash between
 *  them (deploy, OOM, SIGKILL) would previously strand the row unfolded
 *  forever — on restart the row already existed, so it looked already
 *  handled (issue #119). `insertRawEvent`'s `folded_at` check makes
 *  "needs folding" independent of "row exists", so that crash window is
 *  just retried on the next pass instead. */
async function ingestEventQuarantined(ev: DecodedEvent, lastLedger: number): Promise<void> {
  if (typeof ev.ledger === 'number' && lastLedger > 0 && ev.ledger < lastLedger) {
    throw new ReorgDetectedError(
      `event ${ev.id} is from ledger ${ev.ledger}, below the last folded ledger ${lastLedger}`
    )
  }

  const client = await pool.connect()
  let lockAcquired = false
  // Issue #169: set only once this event's own transaction has committed —
  // notified after `finally` releases the lock, on a separate connection,
  // never on `client` itself.
  let committedChannel: StreamChannel | undefined
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext(current_schema()))',
      [REINDEX_LOCK_KEY]
    )
    if (!lockRes.rows[0]?.pg_try_advisory_lock) {
      throw new Error(
        'Cannot fold quarantined event: reindex is currently in progress (advisory lock held)'
      )
    }
    lockAcquired = true

    const needsFold = await insertRawEvent(client, ev)
    if (!needsFold) return // already folded by an earlier attempt at this page

    try {
      await client.query('BEGIN')
      const channel = await applyEvent(client, ev)
      await markFolded(client, ev.id)
      await client.query('COMMIT')
      committedChannel = channel
    } catch (err) {
      await client.query('ROLLBACK')
      await recordQuarantinedEventSafely(ev, err)
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [REINDEX_LOCK_KEY])
      } catch (err) {
        console.error('[indexer] failed to release advisory lock:', err)
      }
    }
    client.release()
  }

  if (committedChannel) {
    await invalidateMemberCachesAfterCommit(committedChannel, ev)
    await notifyStreamClientsAfterCommit(committedChannel, {
      symbol: ev.symbol,
      ledger: ev.ledger,
      timestamp: Date.now(),
    })
  }
}

interface QuarantineState {
  pageKey: string
  errorMessage: string
  failures: number
}

interface QuarantineStateRow {
  page_key: string | null
  error_message: string | null
  failures: number
  escalated_at: string | null
}

// Issue #172: quarantine state now persists in the database so a restart
// doesn't reset the counter. Loads on first use from the persistent row,
// then updated in memory for performance. The database is the source of truth.
let quarantineState: QuarantineState | null = null
let quarantineStateLoaded = false

function pageKeyFor(events: rpc.Api.EventResponse[]): string {
  if (events.length === 0) return ''
  return `${events[0]!.id}..${events[events.length - 1]!.id}:${events.length}`
}

// Issue #172: Load quarantine state from persistent storage. Called once per
// poll cycle before quarantine logic runs. Returns null if the stored state is
// for a different page (i.e., we've moved past the quarantined page).
async function loadQuarantineState(): Promise<QuarantineState | null> {
  try {
    const row = await queryOne<QuarantineStateRow>(
      'SELECT page_key, error_message, failures, escalated_at FROM quarantine_state WHERE id = 1'
    )
    if (!row || !row.page_key || !row.error_message) return null
    return {
      pageKey: row.page_key,
      errorMessage: row.error_message,
      failures: row.failures,
    }
  } catch (err) {
    console.error(`[indexer] failed to load quarantine state: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// Issue #172: Persist quarantine state so it survives a restart. On escalation
// to per-event folding, marks the escalation timestamp for alerting (issue #174).
async function persistQuarantineState(state: QuarantineState | null, escalating = false): Promise<void> {
  try {
    if (state === null) {
      await pool.query(
        `UPDATE quarantine_state SET page_key = NULL, error_message = NULL, failures = 1, escalated_at = NULL, updated_at = now() WHERE id = 1`
      )
    } else {
      await pool.query(
        `INSERT INTO quarantine_state (id, page_key, error_message, failures, escalated_at, updated_at)
         VALUES (1, $1, $2, $3, ${escalating ? 'now()' : 'NULL'}, now())
         ON CONFLICT (id) DO UPDATE SET page_key = $1, error_message = $2, failures = $3, escalated_at = COALESCE(EXCLUDED.escalated_at, quarantine_state.escalated_at), updated_at = now()`,
        [state.pageKey, state.errorMessage, state.failures]
      )
    }
  } catch (err) {
    console.error(
      `[indexer] failed to persist quarantine state: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// Issue #174: Clean up expired failed_events rows (retention policy).
async function cleanupExpiredFailedEvents(): Promise<void> {
  try {
    await pool.query('SELECT delete_expired_failed_events()')
  } catch (err) {
    console.error(`[indexer] failed to cleanup expired failed_events: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Wraps `ingestPage`'s whole-page-transaction fast path with the quarantine
 *  fallback (issue #43). A `ReorgDetectedError` always propagates immediately
 *  — never quarantined, on either path. Any other error is compared against
 *  the previous failure on the same page: once the *same* error has recurred
 *  `INDEXER_QUARANTINE_AFTER_FAILURES` times running on what
 *  `server.getEvents` deterministically returns for the same unmoved cursor
 *  (i.e. the same page), it's treated as deterministic and the page is
 *  retried one event per transaction so the rest of it can still fold.
 *
 *  Issue #172: State persists in the database now so a restart doesn't reset
 *  the counter. Load on first use, update on every iteration, persist after
 *  each decision. */
async function ingestPageWithQuarantine(events: rpc.Api.EventResponse[], lastLedger: number): Promise<void> {
  // Issue #172: Load persistent state on first use
  if (!quarantineStateLoaded) {
    quarantineState = await loadQuarantineState()
    quarantineStateLoaded = true
  }

  try {
    await ingestPage(events, lastLedger)
    // Fold succeeded — clear quarantine state and persist
    quarantineState = null
    await persistQuarantineState(null)
    return
  } catch (err) {
    if (err instanceof ReorgDetectedError) throw err

    const pageKey = pageKeyFor(events)
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (quarantineState && quarantineState.pageKey === pageKey && quarantineState.errorMessage === errorMessage) {
      quarantineState.failures += 1
    } else {
      quarantineState = { pageKey, errorMessage, failures: 1 }
    }

    // Persist after every failure
    await persistQuarantineState(quarantineState)

    if (quarantineState.failures < config.indexer.quarantineAfterFailures) {
      // Might still be transient — let runIndexer's normal backoff-and-retry
      // give it another chance before concluding it's deterministic.
      throw err
    }

    console.error(
      `[indexer] page failed ${quarantineState.failures} consecutive times with the same error — ` +
        `switching to per-event quarantine mode. ${errorMessage}`
    )
    // Issue #174: Mark escalation for alerting
    await persistQuarantineState(quarantineState, true)

    for (const raw of events) {
      const ev = decodeEvent(raw)
      await ingestEventQuarantined(ev, lastLedger)
    }
    quarantineState = null
    await persistQuarantineState(null)
  }
}

/**
 * Fetch events from the Soroban RPC and ingest them into Postgres.
 *
 * Issue #3: drains multiple pages when behind — keeps requesting while the
 * previous page came back full (events.length === pageLimit), bounded by
 * DRAIN_MAX_PAGES and DRAIN_MAX_MS. The cursor is advanced after every page
 * so progress survives a mid-drain crash.
 */
export async function fetchOnce(contractId: string): Promise<void> {
  const cursor = await loadCursor(contractId)

  // Coarse rewind check (issue #23): if the RPC's reported tip is below the
  // ledger we already folded to, the chain rewound past applied history.
  const tip = await getLatestLedgerInfo()
  const priorLedger = cursor?.last_ledger ?? 0
  if (priorLedger > 0 && tip.sequence < priorLedger) {
    throw new ReorgDetectedError(
      `RPC latest ledger ${tip.sequence} is below the last folded ledger ${priorLedger} — the chain rewound past applied history`
    )
  }

  // Same-height fork check (issue #128): the coarse check above only catches
  // a rewind that moves the sequence backwards. A same-height fork — history
  // diverging without the ledger count going down — is invisible to it, but
  // changes the hash of the ledger already folded to. Compare what's stored
  // for `priorLedger` (issue #127: genuinely its hash now, not the tip's)
  // against what the RPC reports for that same sequence today.
  if (priorLedger > 0 && cursor?.last_ledger_hash) {
    const actualHash = await getLedgerHash(priorLedger)
    // null means the RPC has pruned that ledger — unverifiable, not a fork.
    if (actualHash !== null && actualHash !== cursor.last_ledger_hash) {
      throw new ReorgDetectedError(
        `ledger ${priorLedger}'s hash changed from ${cursor.last_ledger_hash} to ${actualHash} — history diverged at the same height`
      )
    }
  }

  const base = {
    filters: [{ type: 'contract' as const, contractIds: [contractId], topics: [] as string[][] }],
    limit: config.indexer.pageLimit,
  }
  const request: Parameters<typeof server.getEvents>[0] = cursor?.paging_token
    ? { ...base, cursor: cursor.paging_token }
    : { ...base, startLedger: await resolveStartLedger() }

  let currentRequest = request
  let totalPages = 0
  const drainStart = Date.now()
  let totalEvents = 0
  let lastLedger = cursor?.last_ledger ?? 0
  let lastLedgerHash = cursor?.last_ledger_hash ?? null
  let observedTipLedger = cursor?.observed_tip_ledger ?? tip.sequence
  let cursorWritten = false

  for (;;) {
    // Check for shutdown signal between pages (issue #47): a SIGTERM
    // arriving mid-drain should stop after the in-flight page, not after
    // the full drain cap.
    if (abortController?.signal.aborted) {
      console.log(`[indexer] drain interrupted by shutdown after ${totalPages} page(s), ${totalEvents} event(s)`)
      break
    }

    const res = await server.getEvents(currentRequest)
    const events = res.events ?? []
    const pageCount = events.length

    // Issue #288: one span per drained page/event-batch, distinct from
    // applyEvent's per-event spans in handlers.ts — this is the unit
    // ingestPageWithQuarantine itself operates on (a whole-page transaction,
    // or one transaction per event once quarantining kicks in).
    await getTracer().startActiveSpan('indexer.page', async (span) => {
      span.setAttribute('page.contract_id', contractId)
      span.setAttribute('page.number', totalPages + 1)
      span.setAttribute('page.event_count', pageCount)
      span.setAttribute('page.last_folded_ledger', lastLedger)
      try {
        await ingestPageWithQuarantine(events, lastLedger)
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err))
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw err
      } finally {
        span.end()
      }
    })
    totalPages += 1
    totalEvents += pageCount

    // Advance cursor after every page (issue #3: per-page cursor advancement).
    const last = events[events.length - 1]
    // Compute the token once (issue #138) and use for both persistence and
    // the next request, so they never diverge if the process crashes mid-flight.
    const nextToken = last?.id ?? res.cursor ?? currentRequest.cursor ?? null
    // Highest ledger actually folded (issue #45): only advances when this
    // page had events. An empty page must never fall through to the RPC tip
    // here — that conflated "folded to" with "chain is at", and a single
    // empty page during catch-up could jump this past ledgers a later, real
    // page would legitimately arrive at, tripping a false ReorgDetectedError.
    const foldedLedger = last?.ledger ?? lastLedger
    // RPC-observed chain tip, tracked separately — freshness reporting only,
    // never fed into the continuity check above or in ingestPage.
    const newObservedTip = res.latestLedger ?? observedTipLedger
    if (nextToken !== cursor?.paging_token || foldedLedger !== lastLedger || newObservedTip !== observedTipLedger) {
      // Only re-fetch the hash when the folded ledger actually moved — the
      // hash of a ledger already folded to doesn't change (issue #127: this
      // stores the hash of `foldedLedger` itself, not the RPC tip's hash).
      const foldedLedgerHash = foldedLedger !== lastLedger ? await getLedgerHash(foldedLedger) : lastLedgerHash
      await saveCursor(contractId, nextToken, foldedLedger, newObservedTip, foldedLedgerHash)
      lastLedger = foldedLedger
      lastLedgerHash = foldedLedgerHash
      observedTipLedger = newObservedTip
      cursorWritten = true
    }

    // Log catch-up progress distinctly from steady-state (issue #3).
    if (pageCount > 0) {
      console.log(`[indexer] page ${totalPages}: ingested ${pageCount} event(s) up to ledger ${foldedLedger}`)
    }

    // Stop draining if:
    //  - short page (tail reached)
    //  - max pages hit
    //  - wall-clock budget exhausted
    const isFullPage = pageCount >= config.indexer.pageLimit
    const pagesExhausted = totalPages >= config.indexer.maxDrainPages
    const timeExhausted = Date.now() - drainStart >= config.indexer.maxDrainMs

    if (!isFullPage || pagesExhausted || timeExhausted) {
      if (pagesExhausted || timeExhausted) {
        console.log(`[indexer] drain cap reached: ${totalPages} pages, ${totalEvents} events, ${Date.now() - drainStart}ms`)
      }
      break
    }

    // Build next request using the same token computed above (issue #138)
    currentRequest = { ...base, cursor: nextToken }
  }

  // On a genuinely idle contract with nothing new to report (no events, and
  // the observed tip/cursor didn't move either), touch updated_at so /ready
  // doesn't falsely report stale (issue #2 context note).
  if (totalEvents === 0 && !cursorWritten) {
    await touchCursor(contractId)
  } else if (totalPages > 1) {
    console.log(`[indexer] drain complete: ${totalPages} pages, ${totalEvents} events in ${Date.now() - drainStart}ms`)
  }
}

/** Resolves after `ms`, or immediately if `signal` aborts first (issue
 *  #121). The backoff delay after a failed poll can be up to
 *  `POLL_MAX_BACKOFF_MS` (60s by default) — without racing it against the
 *  abort signal, a SIGTERM arriving just after a failed poll would wait out
 *  the entire backoff before the loop in `runIndexer` re-checks and exits.
 *
 *  Exported so this can be tested directly: `runIndexer` itself needs
 *  CONTRACT_ID configured, which the test suite doesn't set. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run the poll loop until stopped. Errors are logged and retried with
 *  exponential backoff (capped at `POLL_MAX_BACKOFF_MS`) so a stuck or down
 *  RPC endpoint doesn't get hammered every `pollIntervalMs`. The delay resets
 *  to the normal interval as soon as a poll succeeds. */
export async function runIndexer(): Promise<void> {
  if (running) {
    throw new Error('Indexer is already running — cannot start a second instance')
  }
  // Issue #191: a recorded discontinuity means history diverged from what
  // was folded and the previous run halted on purpose. Resuming would fold
  // events from the diverged history, so refuse until an operator has run
  // `npm run reindex` (which clears it) or `npm run reorg:clear`.
  const halt = await loadUnclearedReorgHalt()
  if (halt) {
    const message =
      `a ledger discontinuity recorded at ${new Date(halt.detected_at).toISOString()} on ${halt.contract_id} ` +
      `(last folded ledger ${halt.last_ledger ?? 'unknown'}) has not been cleared: ${halt.detail}. ` +
      'Confirm the chain state, then run `npm run reindex` (rebuilds and clears) or ' +
      '`npm run reorg:clear` for a false alarm. See docs/REORG_RECOVERY.md.'
    console.error(`[indexer] REFUSING TO RESUME — ${message}`)
    throw new ReorgHaltedError(message)
  }

  // Issue #289: one indexer process can now tail several contracts at once.
  // Each gets its own cursor row (see the migration + loadCursor/saveCursor
  // above) and its own failure/backoff state below, so one contract's RPC
  // trouble doesn't slow down or reset backoff for a healthy one; they're
  // still polled from a single loop (not one task per contract) to keep the
  // existing shutdown/abort-signal handling simple and centralized.
  const contractIds = assertContractsConfigured()
  await ensureCursorContract(contractIds)
  console.log(`[indexer] watching ${contractIds.length} contract(s) on ${config.stellar.rpcUrl}: ${contractIds.join(', ')}`)

  // Latch only once every start-up check has passed, so a failed start
  // (no contract configured, cursor table unavailable) never leaves the
  // process believing an indexer is still running.
  running = true
  abortController = new AbortController()

  const consecutiveFailures = new Map<string, number>()
  const nextPollAt = new Map<string, number>(contractIds.map((id) => [id, 0]))
  // How often the loop wakes to check which contracts are due. A single
  // shared POLL_INTERVAL_MS/POLL_MAX_BACKOFF_MS config applies to every
  // tailed contract; only each contract's own consecutive-failure count
  // (tracked per contract above) differs.
  const tickMs = config.indexer.pollIntervalMs

  try {
    while (!abortController.signal.aborted) {
      const now = Date.now()
      for (const contractId of contractIds) {
        if (abortController.signal.aborted) break
        if ((nextPollAt.get(contractId) ?? 0) > now) continue

        let delay = config.indexer.pollIntervalMs
        try {
          await fetchOnce(contractId)
          consecutiveFailures.set(contractId, 0)
        } catch (err) {
          // A ledger discontinuity is not a transient error — retrying would
          // fold events from a diverged history. Halt loudly (issue #23),
          // for every tailed contract, not just the one that hit it.
          if (err instanceof ReorgDetectedError) {
            console.error(`[indexer] LEDGER DISCONTINUITY DETECTED on ${contractId} — halting the indexer. ${err.message}`)
            console.error(
              `[indexer] Recovery: confirm the true chain state, then run \`npm run reindex\` to rebuild ` +
                `the derived tables from the raw events log. See README "Reorg detection".`
            )
            // Issue #191: persist the halt before exiting so it outlives the
            // process and its logs, and so the next start refuses to resume.
            await recordReorgHalt(contractId, err)
            // Reorg halt is deliberate and permanent for this run — don't
            // reset, so the caller must explicitly restart (issue #48).
            throw err
          }
          const msg = err instanceof Error ? err.message : String(err)
          const failures = (consecutiveFailures.get(contractId) ?? 0) + 1
          consecutiveFailures.set(contractId, failures)
          delay = Math.min(
            config.indexer.pollIntervalMs * 2 ** failures,
            config.indexer.maxBackoffMs
          )
          console.error(
            `[indexer] poll error on ${contractId} (${failures} consecutive): ${msg} — retrying in ${delay}ms`
          )
        }
        nextPollAt.set(contractId, Date.now() + delay)
      }
      await sleep(tickMs, abortController.signal)
    }
  } finally {
    running = false
    abortController = null
  }
}

/** Signal the indexer to stop after the current page completes.
 *  Returns a promise that resolves once runIndexer() has fully exited. */
export function stopIndexer(): Promise<void> {
  console.log('[indexer] shutdown signal received — waiting for current page to complete')
  if (!abortController || !running) return Promise.resolve()
  abortController.abort()

  // Poll until the run loop has fully exited so callers (worker.ts) can
  // safely close the connection pool after this resolves.
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!running) { resolve(); return }
      setTimeout(check, 50)
    }
    check()
  })
}

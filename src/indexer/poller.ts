import type { rpc } from '@stellar/stellar-sdk'
import type { PoolClient } from 'pg'
import { SpanStatusCode } from '@opentelemetry/api'
import { config, assertContractsConfigured } from '../config.js'
import { pool, query, queryOne, acquireWorkerLeaderLock, type WorkerLeaderLock } from '../db/index.js'
import { server, getLatestLedger, getLatestLedgerInfo, getLedgerHash, getLedgers, withRpcSpan } from '../stellar/rpc.js'
import { decodeEvent, type DecodedEvent } from '../stellar/events.js'
import { applyEvent } from './handlers.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'
import { logger } from '../lib/logger.js'

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
// Issue #584: held for the lifetime of the poll loop — see
// acquireWorkerLeaderLock in src/db/index.ts for why this is a distinct lock
// from REINDEX_LOCK_KEY. Null whenever `running` is false.
let leaderLock: WorkerLeaderLock | null = null

// Issue #173: saveCursor can fail after a page is folded, presenting as a
// stalled indexer even though events are being ingested. Track cursor writes
// separately so transient write failures don't wedge progress reporting.
// Issue #383: keyed by contract_id — with multi-contract tailing (issue #289)
// a successful write for one contract must not clear another's failure.
export interface CursorWriteFailure {
  error: string
  at: number
}
const cursorWriteFailures = new Map<string, CursorWriteFailure>()

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

/** Persist the poll cursor after a page has already been folded.
 *
 *  This can fail *after* the fold has committed (a dropped connection, a
 *  lock timeout, the table temporarily unavailable). That is the confusing
 *  failure mode this log line exists for: the indexer is folding correctly,
 *  but it can't record where it got to, so the next poll refetches the same
 *  page and `/ready` may report the cursor as stale. It is distinct from
 *  `[indexer] poll error` (the RPC/getEvents call itself failed, so nothing
 *  was folded) and from `indexer_stale` (the cursor is merely idle — the
 *  indexer may be perfectly healthy). Retrying is safe: raw events are
 *  idempotent on their unique id, so a replayed page does not double-fold.
 *
 *  Exported so tests can exercise the failure path directly. */
export async function saveCursor(
  contractId: string,
  pagingToken: string | null,
  lastLedger: number,
  observedTipLedger: number,
  lastLedgerHash: string | null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO indexer_cursor (id, paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, contract_id, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET paging_token = $1, last_ledger = $2, last_ledger_hash = $3, observed_tip_ledger = $4, contract_id = $5, updated_at = now()`,
      [pagingToken, lastLedger, lastLedgerHash, observedTipLedger, contractId]
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[indexer] Cursor write failed: ${message}`, {
      event: 'cursor_write_failed',
      contractId,
      pagingToken,
      lastLedger,
      observedTipLedger,
      error: message,
    })
    throw err
  }
}

/** Touch updated_at without changing data — keeps freshness signal alive on idle contracts. */
async function touchCursor(contractId: string): Promise<void> {
  await pool.query('UPDATE indexer_cursor SET updated_at = now() WHERE contract_id = $1', [contractId])
}

/** Determine the ledger to start from on a cold start (no saved cursor).
 *  Issue #267: clamps the result to at least 1 so a reorg detected on early
 *  ledgers (within startLookbackLedgers of genesis) can never produce an
 *  invalid sequence for RPC queries. */
async function resolveStartLedger(): Promise<number> {
  if (config.indexer.startLedger > 0) return Math.max(1, config.indexer.startLedger)
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
        const channels = await applyEvent(client, ev)
        if (channels) {
          if (Array.isArray(channels)) {
            for (const ch of channels) pendingNotifications.push({ channel: ch, ev })
          } else {
            pendingNotifications.push({ channel: channels, ev })
          }
        }
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

/** Issue #173: Get the last cursor write failure per contract, if any. Used for
 *  diagnostics to distinguish between a stalled indexer (fold succeeded, cursor
 *  write failed) and genuine staleness (nothing is being folded). Issue #383:
 *  keyed by contract_id; returns a snapshot, not the live map.
 */
export function getCursorWriteFailures(): ReadonlyMap<string, CursorWriteFailure> {
  return new Map(cursorWriteFailures)
}

/** Issue #383: the last cursor write failure for one contract, if any. */
export function getCursorWriteFailure(contractId: string): CursorWriteFailure | null {
  return cursorWriteFailures.get(contractId) ?? null
}

/** Test helper: clear recorded cursor write failures between test cases. */
export function resetCursorWriteFailuresForTests(): void {
  cursorWriteFailures.clear()
}

async function recordQuarantinedEvent(ev: DecodedEvent, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  // Issue #171, #260: fold failures of the same event into one row via UNIQUE constraint.
  // ON CONFLICT updates the row so the latest error message is recorded, and resets
  // resolved_at to NULL for events that were previously resolved but failed again.
  try {
    await pool.query(
      `INSERT INTO failed_events (event_id, contract_id, symbol, ledger, error, created_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (event_id) DO UPDATE SET contract_id = EXCLUDED.contract_id, error = EXCLUDED.error, created_at = now(), resolved_at = NULL`,
      [ev.id, ev.contractId, ev.symbol, ev.ledger, message]
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
  let committedChannels: StreamChannel[] = []
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
      committedChannels = channel ? (Array.isArray(channel) ? channel : [channel]) : []
    } catch (err) {
      await client.query('ROLLBACK')
      // Bookkeeping must not strand the event. If recording the failure itself
      // throws (constraint violation, connection reset, disk full), log loudly
      // and continue so the cursor still advances past this event. The raw log
      // row already committed above, and the derived tables were rolled back.
      try {
        await recordQuarantinedEvent(ev, err)
      } catch (recordErr) {
        console.error(
          `[indexer] failed to record quarantined event ${ev.id} (${ev.symbol}) at ledger ${ev.ledger}:` ,
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        )
      }
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

  for (const committedChannel of committedChannels) {
    await invalidateMemberCachesAfterCommit(committedChannel, ev)
    await notifyStreamClientsAfterCommit(committedChannel, {
      symbol: ev.symbol,
      ledger: ev.ledger,
      timestamp: Date.now(),
    })
  }
}

export interface QuarantineState {
  pageKey: string
  errorMessage: string
  failures: number
}

interface QuarantineStateRow {
  contract_id: string
  page_key: string | null
  error_message: string | null
  failures: number
  escalated_at: string | null
}

// Issue #172, #384: quarantine state now persists in the database keyed by contract_id
// so a restart doesn't reset the counter and multiple tailed contracts do not wipe
// or overwrite each other's failure counts.
const quarantineStates = new Map<string, QuarantineState | null>()
const quarantineStatesLoaded = new Set<string>()

export function resetQuarantineStateInMemory(): void {
  quarantineStates.clear()
  quarantineStatesLoaded.clear()
}

function pageKeyFor(events: rpc.Api.EventResponse[]): string {
  if (events.length === 0) return ''
  return `${events[0]!.id}..${events[events.length - 1]!.id}:${events.length}`
}

// Issue #172, #384: Load quarantine state from persistent storage keyed by contract_id.
export async function loadQuarantineState(contractId?: string): Promise<QuarantineState | null> {
  const targetId = contractId || config.stellar.contractId || 'default'
  try {
    const row = await queryOne<QuarantineStateRow>(
      'SELECT contract_id, page_key, error_message, failures, escalated_at FROM quarantine_state WHERE contract_id = $1',
      [targetId]
    )
    if (!row || !row.page_key || !row.error_message) return null
    return {
      pageKey: row.page_key,
      errorMessage: row.error_message,
      failures: row.failures,
    }
  } catch (err) {
    console.error(`[indexer] failed to load quarantine state for ${targetId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// Issue #172, #384: Persist quarantine state keyed by contract_id so it survives a restart.
export async function persistQuarantineState(
  contractIdOrState: string | QuarantineState | null,
  stateOrEscalating?: QuarantineState | null | boolean,
  escalating = false
): Promise<void> {
  let targetContractId: string
  let state: QuarantineState | null
  let isEscalating = escalating

  if (typeof contractIdOrState === 'string') {
    targetContractId = contractIdOrState
    state = (stateOrEscalating as QuarantineState | null) ?? null
  } else {
    targetContractId = config.stellar.contractId || 'default'
    state = contractIdOrState
    isEscalating = Boolean(stateOrEscalating)
  }

  try {
    if (state === null) {
      await pool.query(
        `INSERT INTO quarantine_state (contract_id, id, page_key, error_message, failures, escalated_at, updated_at)
         VALUES ($1, 1, NULL, NULL, 1, NULL, now())
         ON CONFLICT (contract_id) DO UPDATE SET page_key = NULL, error_message = NULL, failures = 1, escalated_at = NULL, updated_at = now()`,
        [targetContractId]
      )
    } else {
      await pool.query(
        `INSERT INTO quarantine_state (contract_id, id, page_key, error_message, failures, escalated_at, updated_at)
         VALUES ($1, 1, $2, $3, $4, ${isEscalating ? 'now()' : 'NULL'}, now())
         ON CONFLICT (contract_id) DO UPDATE SET page_key = $2, error_message = $3, failures = $4, escalated_at = COALESCE(EXCLUDED.escalated_at, quarantine_state.escalated_at), updated_at = now()`,
        [targetContractId, state.pageKey, state.errorMessage, state.failures]
      )
    }
  } catch (err) {
    console.error(
      `[indexer] failed to persist quarantine state for ${targetContractId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// Issue #174: Clean up expired failed_events rows (retention policy).
export async function cleanupExpiredFailedEvents(): Promise<void> {
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
 *  Issue #172, #384: State persists in the database per contract_id now so a
 *  restart doesn't reset the counter and multiple contracts do not interfere. */
async function ingestPageWithQuarantine(
  events: rpc.Api.EventResponse[],
  lastLedger: number,
  contractId: string = config.stellar.contractId || 'default'
): Promise<void> {
  // Issue #172, #384: Load persistent state on first use for this contract
  if (!quarantineStatesLoaded.has(contractId)) {
    quarantineStates.set(contractId, await loadQuarantineState(contractId))
    quarantineStatesLoaded.add(contractId)
  }

  let state = quarantineStates.get(contractId) ?? null

  try {
    await ingestPage(events, lastLedger)
    // Fold succeeded — clear quarantine state and persist
    quarantineStates.set(contractId, null)
    await persistQuarantineState(contractId, null)
    return
  } catch (err) {
    if (err instanceof ReorgDetectedError) throw err

    const pageKey = pageKeyFor(events)
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (state && state.pageKey === pageKey && state.errorMessage === errorMessage) {
      state.failures += 1
    } else {
      state = { pageKey, errorMessage, failures: 1 }
    }
    quarantineStates.set(contractId, state)

    // Persist after every failure
    await persistQuarantineState(contractId, state)

    if (state.failures < config.indexer.quarantineAfterFailures) {
      // Might still be transient — let runIndexer's normal backoff-and-retry
      // give it another chance before concluding it's deterministic.
      throw err
    }

    console.error(
      `[indexer] [${contractId}] page failed ${state.failures} consecutive times with the same error — ` +
        `switching to per-event quarantine mode. ${errorMessage}`
    )
    // Issue #174: Mark escalation for alerting
    await persistQuarantineState(contractId, state, true)

    for (const raw of events) {
      const ev = decodeEvent(raw)
      await ingestEventQuarantined(ev, lastLedger)
    }
    quarantineStates.set(contractId, null)
    await persistQuarantineState(contractId, null)
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
  const observedTip = cursor?.observed_tip_ledger ?? 0
  
  // Issue #257: if the RPC tip moved backwards but is still ahead of what
  // we've actually folded, this is likely RPC failover to a slightly delayed
  // node, not a genuine reorg. Allow a small grace window (10 ledgers) to
  // tolerate multi-node RPC pool latency without false alarms.
  const GRACE_WINDOW = 10
  if (priorLedger > 0 && tip.sequence < priorLedger) {
    const drift = priorLedger - tip.sequence
    if (observedTip > 0 && drift <= GRACE_WINDOW && tip.sequence >= priorLedger - GRACE_WINDOW) {
      console.warn(
        `[indexer] RPC tip drifted backward by ${drift} ledgers (${tip.sequence} < observed ${observedTip}), ` +
        `but still within grace window — likely RPC failover, not reorg`
      )
      // Continue without throwing; the tip will catch up on the next poll
    } else {
      throw new ReorgDetectedError(
        `RPC latest ledger ${tip.sequence} is below the last folded ledger ${priorLedger} — the chain rewound past applied history`
      )
    }
  }

  // Same-height fork check (issue #128): the coarse check above only catches
  // a rewind that moves the sequence backwards. A same-height fork — history
  // diverging without the ledger count going down — is invisible to it, but
  // changes the hash of the ledger already folded to. Compare what's stored
  // for `priorLedger` (issue #127: genuinely its hash now, not the tip's)
  // against what the RPC reports for that same sequence today.
  // Issue #259: handle null hash return when ledger has aged out of RPC
  // retention window — fall back to sequence-only verification rather than
  // throwing, and log an informative warning.
  if (priorLedger > 0 && cursor?.last_ledger_hash) {
    const actualHash = await getLedgerHash(priorLedger)
    if (actualHash === null) {
      // Ledger has aged out of RPC retention window — unverifiable, not a fork
      console.warn(
        `[indexer] ledger ${priorLedger} hash unavailable (aged out of RPC retention window) — ` +
        `falling back to sequence-only verification. Historical reindexing past retention window ` +
        `cannot verify same-height forks.`
      )
    } else if (actualHash !== cursor.last_ledger_hash) {
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

    // Issue #288: one span per drained page/event-batch, distinct from
    // applyEvent's per-event spans in handlers.ts — this is the unit
    // ingestPageWithQuarantine itself operates on (a whole-page transaction,
    // or one transaction per event once quarantining kicks in).
    // Issue #585: the page's `getEvents` RPC call is made inside this span
    // (as its own `rpc.get_events` child, via withRpcSpan) rather than
    // before it starts, so a trace can show RPC latency separately from
    // ingestPageWithQuarantine's fold time instead of lumping both into the
    // gap between indexer.page spans.
    const { res, events, pageCount } = await getTracer().startActiveSpan('indexer.page', async (span) => {
      span.setAttribute('page.contract_id', contractId)
      span.setAttribute('page.number', totalPages + 1)
      try {
        const res = await withRpcSpan('get_events', 'getEvents', async (rpcSpan) => {
          rpcSpan.setAttribute('rpc.retry_count', 0)
          return server.getEvents(currentRequest)
        })
        const events = res.events ?? []
        const pageCount = events.length
        span.setAttribute('page.event_count', pageCount)
        span.setAttribute('page.last_folded_ledger', lastLedger)
        await ingestPageWithQuarantine(events, lastLedger, contractId)
        return { res, events, pageCount }
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

    // Build next request from the same token we persisted, so an interrupted
    // drain resumes from exactly where we were reading (issue #138).
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

  // Issue #584: refuse to start a second poll loop against the same
  // database/schema while another worker already holds the lock — see
  // acquireWorkerLeaderLock's doc comment (src/db/index.ts) for why this is
  // a distinct, longer-held lock from REINDEX_LOCK_KEY. Acquired before the
  // `running` latch below so a failed acquisition never leaves the process
  // believing an indexer is running.
  leaderLock = await acquireWorkerLeaderLock()
  console.log('[indexer] acquired worker leader-election lock')

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
            // Issue #254: notify stream clients with monotonic reorg ledger
            // height before halting, so they can resync from a known point.
            const cursor = await loadCursor(contractId)
            const reorgLedger = cursor?.last_ledger ?? 0
            try {
              await broadcastResyncToAllChannels({
                type: 'resync',
                event: 'reorg_detected',
                ledger: reorgLedger,
                reorg_ledger: reorgLedger,
                message: 'Ledger discontinuity detected',
                timestamp: Date.now(),
              })
            } catch (notifyErr) {
              console.error('[indexer] failed to notify clients of reorg:', notifyErr)
            }
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
    // Issue #584: release on every exit path (clean stop, or an uncaught
    // error like ReorgHaltedError propagating out of the loop above) so a
    // restart of this same process isn't locked out by its own prior run.
    const lock = leaderLock
    leaderLock = null
    if (lock) await lock.release()
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

import type { Client } from 'pg'

// Issue #279: periodic VACUUM ANALYZE + expired-nonce cleanup, run from
// src/worker.ts alongside the indexer loop.
//
// `VACUUM` cannot run inside a transaction block, and node-postgres's pooled
// `query()`/`withTransaction()` helpers in src/db/index.ts are built around
// transactions — so this deliberately takes a raw `Client` (created via
// `createDedicatedClient()` in src/db/index.ts, entirely outside the shared
// pool) and issues each statement as its own simple query, never wrapped in
// BEGIN/COMMIT. `VACUUM (ANALYZE)` (not `VACUUM FULL`) is used throughout: it
// reclaims dead-tuple space and refreshes the planner's statistics without
// taking the exclusive table lock `VACUUM FULL` would, so it never blocks
// concurrent reads/writes from the API or indexer.
const VACUUM_TABLES = [
  'events',
  'auth_nonces',
  'notifications',
  'members',
  'loan_proposals',
  'loans',
  'treasury_proposals',
] as const

export interface TableMaintenanceResult {
  table: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface MaintenanceResult {
  startedAt: string
  durationMs: number
  tables: TableMaintenanceResult[]
  // Issue #279: complements (never races with) PostgresNonceStore's own
  // sweep in src/auth.ts — that sweep already runs on its own interval
  // whenever a Postgres-backed nonce store is in use, and both statements
  // are simple idempotent DELETEs, so running this one too just means an
  // already-expired row gets deleted by whichever sweep gets there first.
  expiredNoncesDeleted: number | null
  expiredNoncesError?: string
  expiredFailedEventsError?: string
}

/** Run one table's `VACUUM (ANALYZE)`. Never throws — a failure on one table
 *  must not stop the others (issue #279) — the caller inspects `ok`. */
async function vacuumTable(client: Client, table: string): Promise<TableMaintenanceResult> {
  const start = Date.now()
  try {
    // Table names here are a fixed internal list (VACUUM_TABLES), never
    // user input, so this string-built identifier is safe — VACUUM doesn't
    // support parameterized table names in any driver.
    await client.query(`VACUUM (ANALYZE) ${table}`)
    return { table, ok: true, durationMs: Date.now() - start }
  } catch (err) {
    return { table, ok: false, durationMs: Date.now() - start, error: (err as Error).message }
  }
}

/**
 * Run one full maintenance pass: `VACUUM (ANALYZE)` on each of
 * `VACUUM_TABLES`, plus a best-effort sweep of expired `auth_nonces` rows.
 * `client` must be a standalone connection (e.g. `createDedicatedClient()`),
 * not one borrowed from the shared pool — see the module comment above.
 * A failing table (or the nonce sweep) is caught and recorded, never thrown,
 * so one bad statement can't take down the whole run.
 */
export async function runMaintenance(client: Client): Promise<MaintenanceResult> {
  const startedAt = new Date().toISOString()
  const runStart = Date.now()

  const tables: TableMaintenanceResult[] = []
  for (const table of VACUUM_TABLES) {
    tables.push(await vacuumTable(client, table))
  }

  let expiredNoncesDeleted: number | null = null
  let expiredNoncesError: string | undefined
  try {
    const res = await client.query('DELETE FROM auth_nonces WHERE expires_at <= now()')
    expiredNoncesDeleted = res.rowCount ?? 0
  } catch (err) {
    expiredNoncesError = (err as Error).message
  }

  let expiredFailedEventsError: string | undefined
  try {
    await client.query('SELECT delete_expired_failed_events()')
  } catch (err) {
    expiredFailedEventsError = (err as Error).message
  }

  return {
    startedAt,
    durationMs: Date.now() - runStart,
    tables,
    expiredNoncesDeleted,
    expiredNoncesError,
    expiredFailedEventsError,
  }
}

/** Structured log of one maintenance run — start, duration, and per-table
 *  outcome (issue #279's "telemetry": this codebase has no separate metrics
 *  system, so these `[maintenance]`-prefixed log lines are it). */
export function logMaintenanceResult(result: MaintenanceResult): void {
  console.log(
    `[maintenance] run started ${result.startedAt}, finished in ${result.durationMs}ms`
  )
  for (const t of result.tables) {
    if (t.ok) {
      console.log(`[maintenance] VACUUM (ANALYZE) ${t.table} succeeded in ${t.durationMs}ms`)
    } else {
      console.error(`[maintenance] VACUUM (ANALYZE) ${t.table} failed after ${t.durationMs}ms:`, t.error)
    }
  }
  if (result.expiredNoncesError) {
    console.error('[maintenance] expired auth_nonces cleanup failed:', result.expiredNoncesError)
  } else {
    console.log(`[maintenance] deleted ${result.expiredNoncesDeleted ?? 0} expired auth_nonces row(s)`)
  }
  if (result.expiredFailedEventsError) {
    console.error('[maintenance] expired failed_events cleanup failed:', result.expiredFailedEventsError)
  } else {
    console.log('[maintenance] expired failed_events cleanup completed successfully')
  }
}

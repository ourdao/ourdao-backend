import { Client, Pool, types as pgTypes, type PoolClient, type QueryResultRow } from 'pg'
import { config } from '../config.js'

// pg returns Postgres BIGINT (OID 20) as a JS string by default — the safe
// choice, since a BIGINT can exceed Number.MAX_SAFE_INTEGER and would
// silently truncate on conversion. Every BIGINT column in *this* schema is a
// ledger sequence number, comfortably inside that range and typed `number`
// in src/types.ts, so we parse it as one.
//
// Issue #15: this parser is scoped to this pool's `types` config, NOT
// installed on the process-wide `pg.types` registry — a global
// `setTypeParser(20, …)` reached every pg consumer in the process and turned
// "add a BIGINT column" into a silent-truncation trap. Kept here so the
// assumption is visible and local. The column-type rule it depends on —
// on-chain i128 amounts are NUMERIC(40,0) and come back as decimal strings,
// never BIGINT — is documented in the README ("Database schema") and
// CONTRIBUTING.md.
const BIGINT_OID = 20
const parseBigIntAsNumber = (value: string): number => Number.parseInt(value, 10)

const scopedGetTypeParser = ((oid: number, format?: 'text' | 'binary') =>
  oid === BIGINT_OID
    ? parseBigIntAsNumber
    : format === 'binary'
      ? pgTypes.getTypeParser(oid, 'binary')
      : pgTypes.getTypeParser(oid, 'text')
) as unknown as typeof pgTypes.getTypeParser

// A single shared pool. pg picks up PG* env vars automatically; a
// DATABASE_URL connection string takes precedence when provided.
const connectionString =
  config.db.connectionString ||
  process.env.DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test' : undefined)

export const pool = new Pool({
  ...(connectionString ? { connectionString } : {}),
  types: { getTypeParser: scopedGetTypeParser },
  // Issue #152: explicit and documented rather than relying on
  // node-postgres's implicit default (also 10, coincidentally). This pool no
  // longer needs to size for concurrent SSE clients — /api/stream shares one
  // long-lived listener connection for the whole process (src/api/stream.ts)
  // instead of checking one out per client — so DB_POOL_MAX only has to cover
  // ordinary request concurrency (queries, transactions, the nonce store).
  max: config.db.poolMax,
  // Issue #167: without this, a caller waiting on `pool.connect()`/
  // `pool.query()` when every connection is checked out (or Postgres is
  // unreachable at the TCP level) waits forever — there was no bound at all.
  // `/ready` also races its own check against READY_CHECK_TIMEOUT_MS as a
  // second, tighter guard, but every other route sharing this pool benefits
  // from this floor too.
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  // Issue #167: server-side per-statement timeout applied on every
  // connection this pool opens, so a query that hangs after a connection was
  // successfully established (a stuck lock, a database mid-failover) is
  // killed by Postgres rather than left running indefinitely.
  statement_timeout: config.db.statementTimeoutMs,
  // Issue #196: evict idle connections after a configurable time rather than
  // relying on pg's implicit 30s.
  idleTimeoutMillis: config.db.idleTimeoutMs,
  // Issue #196: distinguishes this process's connections (api / worker) in
  // pg_stat_activity.
  application_name: config.db.applicationName,
})

pool.on('error', (err) => {
  // Background idle-client errors shouldn't crash the process.
  console.error('[db] unexpected idle client error:', err.message)
})

/**
 * A standalone connection, entirely outside the pool and its `max` (issue
 * #152's code review): used for the `/api/stream` shared LISTEN connection,
 * which is checked out once and held for the life of the process. Taking it
 * from `pool.connect()` instead would silently consume one of `DB_POOL_MAX`'s
 * slots — the opposite of this pool being "sized for ordinary request
 * concurrency only" — and would make `pool.end()` hang forever on shutdown,
 * since pg-pool's `end()` only resolves once every checked-out client has
 * been released, which a permanently-held listener connection never is.
 */
export function createDedicatedClient(): Client {
  return new Client({
    ...(connectionString ? { connectionString } : {}),
    types: { getTypeParser: scopedGetTypeParser },
    application_name: `${config.db.applicationName}-listener`,
  })
}

/**
 * Issue #196: lift `statement_timeout` for the current transaction only, for
 * the deliberately long-running paths (reindex) that the pool-wide default
 * would otherwise kill. Must be called inside a `BEGIN` — `SET LOCAL` reverts
 * automatically at COMMIT/ROLLBACK, so the connection returns to the pool
 * with the normal limit.
 */
export async function exemptTransactionFromStatementTimeout(client: PoolClient, applicationName?: string): Promise<void> {
  await client.query('SET LOCAL statement_timeout = 0')
  if (applicationName) await client.query(`SELECT set_config('application_name', $1, true)`, [applicationName])
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[])
  return res.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/** Run a set of statements inside a transaction. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

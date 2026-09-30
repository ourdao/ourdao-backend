// Shared harness for DB-backed tests. Applies the real schema.sql to the test
// database (see test/setup.ts for how DATABASE_URL is pointed there) and
// truncates every table between tests so each test starts from empty state.
//
// Issue #204: Each vitest worker now has its own Postgres schema (set up in
// test/setup.ts), making parallel execution safe. This file no longer needs
// to worry about cross-worker races.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pool } from '../src/db/index.js'
import { DERIVED_TABLES } from '../src/indexer/derived-tables.js'

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql')

let schemaApplied: Promise<void> | null = null

function applySchema(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8')
  // Schema is already set in test/setup.ts, so this applies to the worker's schema
  return pool.query(sql).then(() => undefined)
}

/** Idempotent: safe to call from every test file's setup. */
export function ensureSchema(): Promise<void> {
  if (!schemaApplied) schemaApplied = applySchema()
  return schemaApplied
}

// Non-derived tables that must also be truncated between tests.
const NON_DERIVED_TABLES = [
  'events',
  'indexer_cursor',
  'failed_events',
  'quarantine_state',
  'admin_audit_log',
  'reorg_halts',
]

export async function resetDb(): Promise<void> {
  await ensureSchema()
  const allTables = [...DERIVED_TABLES, ...NON_DERIVED_TABLES]
  // Issue #204: TRUNCATE now safe to run in parallel — each worker has its own schema
  await pool.query(`TRUNCATE ${allTables.join(', ')} RESTART IDENTITY CASCADE`)
  // dao_totals is a fixed singleton — reset its values in place and make sure
  // the row exists (schema.sql seeds it, but be defensive against a partial
  // apply during test bootstrap).
  await pool.query(
    `INSERT INTO dao_totals (id) VALUES (1)
     ON CONFLICT (id) DO UPDATE
       SET interest_collected = 0, principal_lent = 0,
           principal_repaid = 0, value_defaulted = 0, updated_at = now()`
  )
}

export async function closeDb(): Promise<void> {
  // Issue #204: With fileParallelism enabled, each worker runs in its own
  // thread pool. Pool cleanup is handled by test/setup.ts's exit handler.
  // Keep this hook for per-file symmetry.
}

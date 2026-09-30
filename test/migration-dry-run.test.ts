// Migration dry-run verification suite (issue #290).
//
// Verifies that all SQL migrations in src/db/migrations/ apply cleanly to an
// empty database and produce a schema matching src/db/schema.sql, and that no
// duplicate migration version IDs exist. This catches broken migrations and
// duplicate version IDs before deployment, guaranteeing a clean deployment on
// fresh database instances.
//
// Design notes:
// - test/setup.ts already called migrate() against the shared test database
//   before this file runs, so the shared pool's database is already fully
//   migrated. The dry-run tests therefore use a *separate*, isolated Postgres
//   database (ourdao_dryrun) to avoid interfering with the rest of the suite.
// - Pool and client lifecycle are managed entirely within this file; no shared
//   state from test/db.ts is used (it operates on a different database).
// - fileParallelism: false in vitest.config.ts serialises file execution, so
//   this file and every other file that uses the shared test DB can't race.
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { assertNoDuplicateVersions, type MigrationFile } from '../src/db/migrate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '../src/db/migrations')
const schemaPath = join(here, '../src/db/schema.sql')

/** Parse the test DATABASE_URL and swap the db name to `ourdao_dryrun`. */
function dryRunConnectionString(): string {
  const base =
    process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
  // Replace the last path segment (the db name) with our isolated db name.
  return base.replace(/\/[^/]+$/, '/ourdao_dryrun')
}

/** Load all *.sql migration files from migrationsDir, sorted by version. */
async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir)
  const files = entries
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({
      version: Number.parseInt(f.split('_')[0]!, 10),
      name: f,
      path: join(migrationsDir, f),
    }))
    .sort((a, b) => a.version - b.version)
  return files
}

/**
 * Return a sorted list of `table_name.column_name` pairs for every
 * user-created table in the given client's current database.
 */
async function schemaColumns(client: pg.Client | pg.PoolClient): Promise<string[]> {
  const res = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`
  )
  return res.rows.map((r) => `${r.table_name}.${r.column_name}`)
}

/**
 * Return a sorted list of index names for every user-created table in the
 * given client's current database.
 */
async function schemaIndexes(client: pg.Client | pg.PoolClient): Promise<string[]> {
  const res = await client.query<{ indexname: string }>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname`
  )
  return res.rows.map((r) => r.indexname)
}

// ---------------------------------------------------------------------------
// Suite-level database management
// ---------------------------------------------------------------------------

// A pg.Pool targeting the isolated dry-run database.  Created in beforeAll,
// ended in afterAll.
let dryRunPool: pg.Pool

beforeAll(async () => {
  // Connect to the default `ourdao_test` database as a superuser-equivalent
  // connection to CREATE / DROP the dry-run database.
  const adminClient = new pg.Client(
    process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
  )
  await adminClient.connect()
  // Force-close any existing connections so DROP DATABASE doesn't hang.
  await adminClient.query(`
    SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
     WHERE datname = 'ourdao_dryrun' AND pid <> pg_backend_pid()
  `)
  await adminClient.query('DROP DATABASE IF EXISTS ourdao_dryrun')
  await adminClient.query('CREATE DATABASE ourdao_dryrun')
  await adminClient.end()

  dryRunPool = new pg.Pool({ connectionString: dryRunConnectionString() })
})

afterAll(async () => {
  await dryRunPool?.end()

  // Clean up the dry-run database so it doesn't persist between runs.
  const adminClient = new pg.Client(
    process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
  )
  await adminClient.connect()
  await adminClient.query(`
    SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
     WHERE datname = 'ourdao_dryrun' AND pid <> pg_backend_pid()
  `)
  await adminClient.query('DROP DATABASE IF EXISTS ourdao_dryrun')
  await adminClient.end()
})

// ---------------------------------------------------------------------------
// assertNoDuplicateVersions — unit tests (no DB required)
// ---------------------------------------------------------------------------

describe('assertNoDuplicateVersions (unit)', () => {
  it('does not throw when all versions are unique', () => {
    expect(() =>
      assertNoDuplicateVersions([
        { version: 1, name: '0001_widen_vote_columns.sql' },
        { version: 2, name: '0002_loans_total_repayment_due_time.sql' },
        { version: 3, name: '0003_cursor_contract_id.sql' },
      ])
    ).not.toThrow()
  })

  it('does not throw when versions have gaps (gaps are allowed)', () => {
    expect(() =>
      assertNoDuplicateVersions([
        { version: 10, name: '0010_documents.sql' },
        { version: 12, name: '0012_status_check_constraints.sql' }, // gap at 11
        { version: 13, name: '0013_events_entity_id_idx.sql' },
        { version: 15, name: '0015_events_ledger_id_idx.sql' },    // gap at 14
      ])
    ).not.toThrow()
  })

  it('throws naming both files when two migrations claim the same version', () => {
    expect(() =>
      assertNoDuplicateVersions([
        { version: 14, name: '0014_auth_nonces.sql' },
        { version: 14, name: '0014_events_decode_error.sql' },
      ])
    ).toThrowError(/duplicate migration version 14.*0014_auth_nonces\.sql.*0014_events_decode_error\.sql/)
  })

  it('throws when a duplicate appears beyond the first pair', () => {
    expect(() =>
      assertNoDuplicateVersions([
        { version: 1, name: '0001_a.sql' },
        { version: 2, name: '0002_b.sql' },
        { version: 2, name: '0002_c.sql' },
      ])
    ).toThrowError(/duplicate migration version 2/)
  })
})

// ---------------------------------------------------------------------------
// On-disk migrations/ directory — no duplicate versions
// ---------------------------------------------------------------------------

describe('on-disk migrations directory', () => {
  it('has no duplicate version numbers across all migration files', async () => {
    const migrations = await loadMigrations()
    expect(() => assertNoDuplicateVersions(migrations)).not.toThrow()
  })

  it('contains at least one migration file', async () => {
    const migrations = await loadMigrations()
    expect(migrations.length).toBeGreaterThan(0)
  })

  it('every filename follows the NNNN_description.sql convention', async () => {
    const entries = await readdir(migrationsDir)
    const sqlFiles = entries.filter((f) => f.endsWith('.sql'))
    for (const f of sqlFiles) {
      expect(f, `${f} does not match NNNN_*.sql`).toMatch(/^\d{4}_.*\.sql$/)
    }
  })

  it('versions are strictly increasing (files are ordered)', async () => {
    const migrations = await loadMigrations()
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i]!.version).toBeGreaterThan(migrations[i - 1]!.version)
    }
  })
})

// ---------------------------------------------------------------------------
// Dry-run: apply all migrations 0001 → latest on a fresh database
// ---------------------------------------------------------------------------

describe('migrations dry-run on fresh database', () => {
  it('applies all migrations from 0001 through latest without error', async () => {
    const client = await dryRunPool.connect()
    try {
      // Bootstrap schema_migrations tracking table so migrate.ts can record
      // each applied migration (this is what schema.sql's first CREATE TABLE
      // does — we run it here manually since we're not using migrate()'s
      // schema.sql bootstrap path; we want to exercise the real SQL path).
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)

      const migrations = await loadMigrations()

      for (const migration of migrations) {
        const sql = await readFile(migration.path, 'utf8')
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
            [migration.version, migration.name]
          )
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw new Error(
            `migration ${migration.name} failed on fresh database: ${(err as Error).message}`,
            { cause: err }
          )
        }
      }

      // Every migration file must have a corresponding schema_migrations row.
      const recorded = await client.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      const recordedVersions = recorded.rows.map((r) => r.version)
      const expectedVersions = migrations.map((m) => m.version)
      expect(recordedVersions).toEqual(expectedVersions)
    } finally {
      client.release()
    }
  })
})

// ---------------------------------------------------------------------------
// Schema equivalence: migration end-state matches schema.sql
// ---------------------------------------------------------------------------

describe('migration end-state matches schema.sql', () => {
  it('tables and columns produced by migrations match those from schema.sql', async () => {
    // --- Left side: columns from the dry-run database (migrations path) ---
    const dryRunClient = await dryRunPool.connect()
    let migrationColumns: string[]
    try {
      migrationColumns = await schemaColumns(dryRunClient)
    } finally {
      dryRunClient.release()
    }

    // --- Right side: columns from schema.sql applied to a temp database ---
    // Use a second isolated database (ourdao_schema_check) so the two sides
    // are both cleanly bootstrapped without interfering with each other.
    const adminClient = new pg.Client(
      process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
    )
    await adminClient.connect()
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
       WHERE datname = 'ourdao_schema_check' AND pid <> pg_backend_pid()
    `)
    await adminClient.query('DROP DATABASE IF EXISTS ourdao_schema_check')
    await adminClient.query('CREATE DATABASE ourdao_schema_check')
    await adminClient.end()

    const schemaCheckConnStr = (
      process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
    ).replace(/\/[^/]+$/, '/ourdao_schema_check')

    const schemaClient = new pg.Client(schemaCheckConnStr)
    await schemaClient.connect()
    let schemaColumns_: string[]
    try {
      const schemaSql = await readFile(schemaPath, 'utf8')
      await schemaClient.query(schemaSql)
      schemaColumns_ = await schemaColumns(schemaClient)
    } finally {
      await schemaClient.end()
    }

    // Drop the temp schema-check database.
    const cleanupClient = new pg.Client(
      process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
    )
    await cleanupClient.connect()
    await cleanupClient.query(`
      SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
       WHERE datname = 'ourdao_schema_check' AND pid <> pg_backend_pid()
    `)
    await cleanupClient.query('DROP DATABASE IF EXISTS ourdao_schema_check')
    await cleanupClient.end()

    // schema_migrations itself is not part of schema.sql's "application"
    // tables but IS created in both paths. Filter it out for the diff so we
    // don't need to care about ordering of that table's columns.
    const filtered = (cols: string[]) =>
      cols.filter((c) => !c.startsWith('schema_migrations.'))

    // Every column that schema.sql defines must exist after migrations run.
    // (The reverse — columns added by migrations that aren't yet in schema.sql
    // — should never happen because schema.sql is kept at HEAD, but we check
    // only one direction to avoid false positives during active development.)
    const schemaSet = new Set(filtered(schemaColumns_))
    const missing = filtered(migrationColumns).filter((c) => !schemaSet.has(c))

    expect(
      missing,
      `columns present after migrations that are absent from schema.sql: ${missing.join(', ')}`
    ).toEqual([])

    const migrationSet = new Set(filtered(migrationColumns))
    const extra = filtered(schemaColumns_).filter((c) => !migrationSet.has(c))

    expect(
      extra,
      `columns defined in schema.sql that are absent after migrations: ${extra.join(', ')}`
    ).toEqual([])
  })

  it('indexes produced by migrations match those from schema.sql', async () => {
    // Dry-run indexes (already applied in the previous test's client).
    const dryRunClient = await dryRunPool.connect()
    let migrationIndexes: string[]
    try {
      migrationIndexes = await schemaIndexes(dryRunClient)
    } finally {
      dryRunClient.release()
    }

    // Schema.sql indexes (rebuild schema-check DB for a clean baseline).
    const adminClient = new pg.Client(
      process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
    )
    await adminClient.connect()
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
       WHERE datname = 'ourdao_schema_check2' AND pid <> pg_backend_pid()
    `)
    await adminClient.query('DROP DATABASE IF EXISTS ourdao_schema_check2')
    await adminClient.query('CREATE DATABASE ourdao_schema_check2')
    await adminClient.end()

    const schemaCheckConnStr = (
      process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
    ).replace(/\/[^/]+$/, '/ourdao_schema_check2')

    const schemaClient = new pg.Client(schemaCheckConnStr)
    await schemaClient.connect()
    let schemaSideIndexes: string[]
    try {
      const schemaSql = await readFile(schemaPath, 'utf8')
      await schemaClient.query(schemaSql)
      schemaSideIndexes = await schemaIndexes(schemaClient)
    } finally {
      await schemaClient.end()
    }

    const cleanupClient = new pg.Client(
      process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'
    )
    await cleanupClient.connect()
    await cleanupClient.query(`
      SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
       WHERE datname = 'ourdao_schema_check2' AND pid <> pg_backend_pid()
    `)
    await cleanupClient.query('DROP DATABASE IF EXISTS ourdao_schema_check2')
    await cleanupClient.end()

    // Primary key constraint indexes are auto-named by Postgres and may
    // differ between the two paths depending on CREATE TABLE vs ALTER TABLE
    // PRIMARY KEY. Exclude them; we care about named application indexes.
    const filtered = (idxs: string[]) => idxs.filter((i) => !i.endsWith('_pkey'))

    const schemaSet = new Set(filtered(schemaSideIndexes))
    const missing = filtered(migrationIndexes).filter((i) => !schemaSet.has(i))
    expect(
      missing,
      `indexes present after migrations that are absent from schema.sql: ${missing.join(', ')}`
    ).toEqual([])

    const migrationSet = new Set(filtered(migrationIndexes))
    const extra = filtered(schemaSideIndexes).filter((i) => !migrationSet.has(i))
    expect(
      extra,
      `indexes defined in schema.sql that are absent after migrations: ${extra.join(', ')}`
    ).toEqual([])
  })

  it('key application tables exist after migrations (spot-check)', async () => {
    const client = await dryRunPool.connect()
    try {
      const tables = [
        'events',
        'members',
        'loans',
        'loan_proposals',
        'treasury_proposals',
        'notifications',
        'dao_totals',
        'interest_distributions',
        'failed_events',
        'documents',
        'auth_nonces',
        'quarantine_state',
        'indexer_cursor',
      ]
      for (const table of tables) {
        const res = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
          [table]
        )
        expect(res.rows, `table '${table}' is missing after migrations`).toHaveLength(1)
      }
    } finally {
      client.release()
    }
  })

  it('columns added by individual migrations are present (regression guard)', async () => {
    // Spot-check columns introduced by migrations that were once the
    // subject of duplicate-version defects (issues #161, #204).
    const client = await dryRunPool.connect()
    try {
      const checks: Array<{ table: string; column: string; migration: string }> = [
        { table: 'events', column: 'decode_error', migration: '0019' },
        { table: 'events', column: 'folded_at', migration: '0016' },
        { table: 'notifications', column: 'event_id', migration: '0020' },
        { table: 'failed_events', column: 'resolved_at', migration: '0021' },
      ]
      for (const { table, column, migration } of checks) {
        const res = await client.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column]
        )
        expect(
          res.rows,
          `column '${table}.${column}' (added by migration ${migration}) is missing after migrations`
        ).toHaveLength(1)
      }
    } finally {
      client.release()
    }
  })
})

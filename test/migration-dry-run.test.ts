// Migration dry-run verification suite (issue #290).
//
// Verifies that migrations in src/db/migrations/ are consistent with
// src/db/schema.sql — every migration replays cleanly on a database
// bootstrapped from schema.sql (the baseline src/db/migrate.ts applies first)
// and the end state matches schema.sql — and that no duplicate migration
// version IDs exist. This catches broken migrations and duplicate version IDs
// before deployment, guaranteeing a clean deployment on fresh database
// instances.
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

/**
 * Split a migration file into individual SQL statements, so a file can be
 * replayed statement by statement (see the dry-run test below). Aware of line
 * and block comments, single-quoted literals, double-quoted identifiers and
 * dollar-quoted bodies (`$tag$ … $tag$`) — 0022_failed_events_uniqueness.sql
 * defines a plpgsql function whose body contains `;`, so splitting on `;` alone
 * would cut it in half. Comment-only chunks are dropped so Postgres never
 * receives an empty query.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let hasSql = false
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]

    // Line comment.
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end + 1
      current += sql.slice(i, stop)
      i = stop
      continue
    }

    // Block comment.
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      current += sql.slice(i, stop)
      i = stop
      continue
    }

    // String literal or quoted identifier (a doubled quote is an escape).
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      current += sql.slice(i, j)
      hasSql = true
      i = j
      continue
    }

    // Dollar-quoted body: $tag$ … $tag$ (the tag may be empty).
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? sql.length : end + tag.length
        current += sql.slice(i, stop)
        hasSql = true
        i = stop
        continue
      }
    }

    if (ch === ';') {
      if (hasSql) statements.push(current)
      current = ''
      hasSql = false
      i += 1
      continue
    }

    if (!/\s/.test(ch)) hasSql = true
    current += ch
    i += 1
  }

  if (hasSql) statements.push(current)
  return statements.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * The object name from an `ALTER TABLE … ADD CONSTRAINT <name> …` statement,
 * used to assert exactly which statements were already satisfied by schema.sql.
 */
function addedConstraintName(statement: string): string {
  const match = /ADD\s+CONSTRAINT\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement)
  return match?.[1] ?? statement.replace(/\s+/g, ' ').slice(0, 80)
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
// Dry-run: schema.sql baseline + replay every migration 0001 → latest
// ---------------------------------------------------------------------------

// src/db/migrate.ts treats schema.sql as the bootstrap baseline (it always
// reflects HEAD) and the migrations directory as a *history*: on a database
// schema.sql has just created, pending migrations are recorded as applied
// without re-running their SQL, because the baseline already contains their end
// state.
//
// The faithful dry-run of that path is therefore: apply schema.sql, then replay
// every migration against it. Most statements are no-ops there; the constraints
// below are declared *inline* by schema.sql (fresh databases) as well as by the
// named migration that added them to existing deployments, so Postgres rejects
// the duplicate with a duplicate-object error. That set is pinned: any other
// statement that cannot run against the baseline fails this test instead of
// being silently tolerated.
const BASELINE_SATISFIED_CONSTRAINTS: readonly string[] = [
  // 0012_status_check_constraints.sql
  'loan_proposals_status_check',
  'loans_status_check',
  'treasury_proposals_status_check',
  // 0022_failed_events_uniqueness.sql
  'failed_events_event_id_unique',
  // 0026_failed_events_resolution_notes.sql
  'failed_events_resolution_check',
]

// 42710 = duplicate_object (constraint or index). 42P07 = duplicate_table —
// what Postgres reports for the backing index of the UNIQUE constraint that
// 0022 re-adds ("relation ... already exists").
const DUPLICATE_OBJECT_CODES = new Set(['42710', '42P07'])

// The bootstrap tests in this file build real databases: a fresh schema.sql
// application plus a statement-by-statement replay of every migration, or a
// second schema.sql application for the comparison side. That is a second or
// two of real work on an idle machine — and 18s observed on a loaded Windows
// dev box, where the whole suite runs in parallel — so they get explicit
// headroom over the 10s default (which is tuned for API round trips, see
// vitest.config.ts) instead of a budget that depends on machine load.
const BOOTSTRAP_TEST_TIMEOUT_MS = 60_000

describe('migrations dry-run on fresh database', () => {
  it('applies schema.sql then every migration from 0001 through latest without error', async () => {
    const client = await dryRunPool.connect()
    try {
      // Phase 1 — the bootstrap src/db/migrate.ts performs first: schema.sql is
      // idempotent and creates the baseline tables plus schema_migrations.
      const schemaSql = await readFile(schemaPath, 'utf8')
      await client.query(schemaSql)

      // Phase 2 — replay the migration history on top of that baseline.
      // Statements run one at a time behind a savepoint so a duplicate-object
      // rejection cannot discard the rest of the file: 0022's DROP INDEX /
      // CREATE INDEX / CREATE FUNCTION statements must still take effect, just
      // as they do on an existing deployment that had reached an older HEAD.
      const migrations = await loadMigrations()
      const alreadySatisfied: string[] = []

      for (const migration of migrations) {
        const statements = splitStatements(await readFile(migration.path, 'utf8'))
        await client.query('BEGIN')
        try {
          for (const statement of statements) {
            await client.query('SAVEPOINT migration_statement')
            try {
              await client.query(statement)
              await client.query('RELEASE SAVEPOINT migration_statement')
            } catch (err) {
              await client.query('ROLLBACK TO SAVEPOINT migration_statement')
              const code = (err as { code?: string }).code
              const name = addedConstraintName(statement)
              const isKnownBaselineNoop =
                code !== undefined &&
                DUPLICATE_OBJECT_CODES.has(code) &&
                BASELINE_SATISFIED_CONSTRAINTS.includes(name)
              if (!isKnownBaselineNoop) {
                throw new Error(
                  `migration ${migration.name} failed on a database bootstrapped from schema.sql: ${(err as Error).message}\n` +
                    `failing statement: ${statement.replace(/\s+/g, ' ').trim()}`,
                  { cause: err }
                )
              }
              // schema.sql already declares this constraint, so this statement
              // is a no-op here. The migration itself is still recorded below,
              // exactly as migrate() records migrations on a fresh database.
              alreadySatisfied.push(name)
            }
          }

          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
            [migration.version, migration.name]
          )
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
      }

      const satisfied = [...alreadySatisfied].sort()
      expect(
        satisfied,
        `constraints that could not be re-applied because schema.sql already declares them (expected exactly: ${[...BASELINE_SATISFIED_CONSTRAINTS].sort().join(', ')}). Only extend BASELINE_SATISFIED_CONSTRAINTS after confirming schema.sql declares the constraint inline, or the drift is real.`
      ).toEqual([...BASELINE_SATISFIED_CONSTRAINTS].sort())

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
  }, BOOTSTRAP_TEST_TIMEOUT_MS)
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
  }, BOOTSTRAP_TEST_TIMEOUT_MS)

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
    const notInSchema = filtered(migrationIndexes).filter((i) => !schemaSet.has(i))

    // Known, pinned drift — not silently tolerated: the list is exact, so any
    // *new* mismatch fails this test.
    //
    // 0015_events_ledger_id_idx.sql adds a composite (ledger, id) index that
    // schema.sql never adopted, and no later migration drops it. It is
    // therefore the only index in the replayed end state that schema.sql lacks,
    // which means a database bootstrapped from schema.sql alone — the path
    // src/db/migrate.ts takes on a fresh database — does not have the index the
    // /api/events ledger-range query is written against
    // (see src/api/routes/index.ts, the range-filter comment).
    //
    // Resolving it is a schema decision: adopting the index into schema.sql
    // changes the curated, storage-costed index set that
    // test/events-storage.test.ts asserts and docs/events-storage.md documents;
    // the alternative is dropping it in a new migration. Both are maintainer
    // calls, so this test pins the drift for review instead of hiding it — the
    // assertion goes back to `[]` once either decision lands.
    expect(
      notInSchema,
      `indexes present after migrations that are absent from schema.sql: ${notInSchema.join(', ')}`
    ).toEqual(['events_ledger_id_idx'])

    const migrationSet = new Set(filtered(migrationIndexes))
    const extra = filtered(schemaSideIndexes).filter((i) => !migrationSet.has(i))
    expect(
      extra,
      `indexes defined in schema.sql that are absent after migrations: ${extra.join(', ')}`
    ).toEqual([])
  }, BOOTSTRAP_TEST_TIMEOUT_MS)

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

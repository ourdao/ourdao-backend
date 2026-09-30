// Runs before every test file. Points the shared `pool` (src/db/index.ts) at
// a dedicated test database instead of whatever DATABASE_URL is set to for
// dev, so tests never touch real data. `dotenv/config` (loaded by
// src/config.ts) only fills in env vars that aren't already set, so this
// takes precedence as long as it runs first — which vitest guarantees for
// setupFiles.

// Issue #204: Each vitest worker gets its own Postgres schema, making
// parallel test execution safe. The schema name is derived from the worker
// index (VITEST_POOL_ID), ensuring isolation without requiring separate
// physical databases.
const workerId = process.env.VITEST_POOL_ID || '1'
const testSchema = `test_worker_${workerId}`

// Store the schema name for use by test/db.ts
process.env.TEST_SCHEMA = testSchema

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'

// Every connection this process opens — the shared pool, dedicated
// listener/maintenance clients, the reindex client, and any ad-hoc `pg.Pool`
// a test creates — must resolve unqualified table names in this worker's
// schema. `PGOPTIONS` is read by node-postgres as the libpq startup
// `options` parameter, so the search_path is applied at connection time
// with no shared state. (An earlier version set it with
// `ALTER ROLE ... SET search_path`, which is role-wide: parallel workers
// overwrote each other's default and connections opened mid-run landed in
// another worker's schema.)
process.env.PGOPTIONS = `-c search_path=${testSchema},public`

// buildServer() (src/api/server.ts) reads this to configure its Fastify
// logger. Route tests build a real server per-test, so leaving it at the
// 'info' default would drown test output in per-request log lines.
process.env.LOG_LEVEL ??= 'silent'

// Create the schema for this worker and apply migrations
const { pool } = await import('../src/db/index.js')
const { migrate } = await import('../src/db/migrate.js')

try {
  // Create schema if it doesn't exist. The connection already has
  // search_path pointed at it via PGOPTIONS above.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${testSchema}"`)

  // Apply migrations to this schema
  await migrate()
} catch (err) {
  console.error(`[test/setup] Failed to initialize schema ${testSchema}:`, err)
  throw err
}

// Best-effort cleanup when tests complete. This won't run if the process is
// killed hard (SIGKILL), so a separate cleanup script (scripts/clean-test-schemas.ts)
// handles orphaned schemas.
process.on('beforeExit', () => {
  pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`).catch(() => {
    // Ignore errors during cleanup
  })
})

// Make this file a module to allow top-level await
export {}

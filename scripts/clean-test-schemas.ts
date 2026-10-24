#!/usr/bin/env node --import=tsx
/**
 * Clean up orphaned test_worker_* schemas left behind by interrupted test runs
 * (issues #204, #416).
 *
 * Parallel test execution creates one schema per worker (test_worker_1,
 * test_worker_2, etc.). test/setup.ts creates and migrates its worker schema
 * once when a test file starts and drops it on clean exit, so a killed test
 * run leaves schemas behind.
 *
 * IMPORTANT: Do NOT run this script while `npm test` is running. Because
 * test/setup.ts does not recreate a dropped schema mid-file, dropping a live
 * worker schema will cause in-flight test queries to fail. By default this
 * script refuses to drop schemas when active sessions are connected to the
 * test database (pass `--force` to override) and refuses to run when
 * `DATABASE_URL` points at a database other than `TEST_DATABASE_URL`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

export const DEFAULT_TEST_DATABASE_URL =
  'postgres://ourdao:ourdao@localhost:5432/ourdao_test'

export const LIST_TEST_SCHEMAS_SQL = `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'test\_worker\_%' ESCAPE '\'
       ORDER BY schema_name`

export const ACTIVE_TEST_SESSIONS_SQL = `SELECT pid
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND (
           query LIKE '%test\_worker\_%' ESCAPE '\'
           OR state <> 'idle'
         )`

const VALID_TEST_SCHEMA_RE = /^test_worker_[0-9a-zA-Z_]+$/

export interface CleanTestSchemasOptions {
  force: boolean
}

export interface QueryablePool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>
  end(): Promise<void>
}

export function parseCleanArgs(argv: readonly string[]): CleanTestSchemasOptions {
  let force = false
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') {
      force = true
    } else {
      throw new Error(`Unknown option "${arg}". Usage: clean-test-schemas.ts [--force]`)
    }
  }
  return { force }
}

function isLikelyTestDatabaseUrl(connectionString: string): boolean {
  try {
    const parsed = new URL(connectionString)
    const dbName = parsed.pathname.replace(/^\/+/, '')
    return dbName === 'test' || dbName.endsWith('_test') || dbName.startsWith('test_')
  } catch {
    return false
  }
}

/**
 * Resolve and validate the target connection string for schema cleanup.
 * Refuses to run when DATABASE_URL is pointed at a non-test database or does
 * not match TEST_DATABASE_URL.
 */
export function resolveCleanupDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const expectedTestUrl = env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL
  const configuredDatabaseUrl = env.DATABASE_URL?.trim()

  if (configuredDatabaseUrl && configuredDatabaseUrl !== expectedTestUrl) {
    throw new Error(
      `Refusing to clean test schemas: DATABASE_URL (${configuredDatabaseUrl}) does not match TEST_DATABASE_URL (${expectedTestUrl}).`
    )
  }

  const targetUrl = configuredDatabaseUrl || expectedTestUrl
  if (!isLikelyTestDatabaseUrl(targetUrl)) {
    throw new Error(
      `Refusing to clean test schemas: target database URL (${targetUrl}) is not a test database.`
    )
  }

  return targetUrl
}

export async function cleanTestSchemas(
  db: QueryablePool,
  options: CleanTestSchemasOptions = { force: false }
): Promise<string[]> {
  if (!options.force) {
    const { rows: activeSessions } = await db.query<{ pid: number }>(
      ACTIVE_TEST_SESSIONS_SQL
    )
    if (activeSessions.length > 0) {
      throw new Error(
        `Refusing to drop test schemas while ${activeSessions.length} active session(s) are using the test database. Wait for tests to finish or pass --force.`
      )
    }
  }

  const { rows } = await db.query<{ schema_name: string }>(LIST_TEST_SCHEMAS_SQL)

  if (rows.length === 0) {
    console.log('No orphaned test schemas found.')
    return []
  }

  const schemaNames = rows
    .map((r) => r.schema_name)
    .filter((name) => VALID_TEST_SCHEMA_RE.test(name))

  console.log(
    `Found ${schemaNames.length} test schema(s):`,
    schemaNames.join(', ')
  )

  for (const schemaName of schemaNames) {
    console.log(`Dropping ${schemaName}...`)
    await db.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  }

  console.log(`✓ Cleaned up ${schemaNames.length} test schema(s)`)
  return schemaNames
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const options = parseCleanArgs(argv)
  const connectionString = resolveCleanupDatabaseUrl(env)
  const cleanupPool = new Pool({ connectionString })

  try {
    await cleanTestSchemas(cleanupPool, options)
  } finally {
    await cleanupPool.end()
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[clean-test-schemas] failed:', err)
    process.exit(1)
  })
}

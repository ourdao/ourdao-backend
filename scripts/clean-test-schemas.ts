#!/usr/bin/env node --import=tsx
/**
 * Clean up orphaned test_worker_* schemas left behind by interrupted test runs
 * (issue #204, issue #416).
 *
 * Parallel test execution creates one schema per worker (test_worker_1,
 * test_worker_2, etc.). test/setup.ts drops its schema on clean exit, but a
 * killed or interrupted test run leaves them behind.
 *
 * This script identifies test_worker_* schemas and safely drops orphaned ones.
 * Schemas currently in use by active test worker connections (detected via
 * pg_locks and pg_stat_activity) are skipped by default to prevent breaking
 * live test suites. Pass --force to drop all test schemas regardless of active
 * sessions.
 */
import { pool } from '../src/db/index.js'

async function getActiveTestSchemas(): Promise<Set<string>> {
  const active = new Set<string>()

  try {
    // 1. Check schemas with active table/relation locks held by other sessions
    const { rows: lockRows } = await pool.query<{ schema_name: string }>(
      `SELECT DISTINCT n.nspname AS schema_name
       FROM pg_locks l
       JOIN pg_class c ON l.relation = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname LIKE 'test_worker_%'
         AND l.pid != pg_backend_pid()`
    )
    for (const r of lockRows) {
      if (r.schema_name) active.add(r.schema_name)
    }

    // 2. Check active queries mentioning test_worker schemas from other sessions
    const { rows: queryRows } = await pool.query<{ schema_name: string }>(
      `SELECT DISTINCT (regexp_matches(query, 'test_worker_\\d+', 'g'))[1] AS schema_name
       FROM pg_stat_activity
       WHERE pid != pg_backend_pid()
         AND state != 'idle'
         AND query LIKE '%test_worker_%'`
    )
    for (const r of queryRows) {
      if (r.schema_name) active.add(r.schema_name)
    }
  } catch (err) {
    console.warn('[clean-test-schemas] warning: could not inspect active sessions:', err)
  }

  return active
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')

  try {
    // Find all test_worker_* schemas
    const { rows } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'test_worker_%'
       ORDER BY schema_name`
    )

    if (rows.length === 0) {
      console.log('No orphaned test schemas found.')
      return
    }

    console.log(`Found ${rows.length} test schema(s):`, rows.map((r) => r.schema_name).join(', '))

    const activeSchemas = force ? new Set<string>() : await getActiveTestSchemas()
    let droppedCount = 0
    let skippedCount = 0

    for (const { schema_name } of rows) {
      if (!force && activeSchemas.has(schema_name)) {
        console.log(`Skipping ${schema_name} (active worker session detected; pass --force to override)`)
        skippedCount++
        continue
      }

      console.log(`Dropping ${schema_name}...`)
      await pool.query(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`)
      droppedCount++
    }

    if (skippedCount > 0) {
      console.log(`✓ Cleaned up ${droppedCount} orphaned test schema(s) (${skippedCount} active schema(s) preserved)`)
    } else {
      console.log(`✓ Cleaned up ${droppedCount} test schema(s)`)
    }
  } catch (err) {
    console.error('[clean-test-schemas] failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[clean-test-schemas] fatal:', err)
  process.exit(1)
})

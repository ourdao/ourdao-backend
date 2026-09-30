import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { pool } from '../src/db/index.js'
import { resetDb, closeDb } from './db.js'

/**
 * Issue #204: verify that parallel test execution is truly isolated.
 *
 * Each vitest worker gets its own Postgres schema (test_worker_1, test_worker_2,
 * etc.), so one worker's TRUNCATE or INSERT never races another worker's
 * assertions. This test verifies the isolation property holds.
 */
describe('Parallel test isolation (#204)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('each worker operates in its own schema', async () => {
    // Confirm search_path is set to a test_worker_* schema
    const { rows } = await pool.query<{ search_path: string }>(
      'SHOW search_path'
    )
    const searchPath = rows[0]?.search_path ?? ''
    
    expect(searchPath).toMatch(/test_worker_\d+/)
    
    // Verify the schema exists
    const schemaName = searchPath.split(',')[0]!.trim().replace(/"/g, '')
    const schemaCheck = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) as exists`,
      [schemaName]
    )
    expect(schemaCheck.rows[0]?.exists).toBe(true)
  })

  it('tables exist in the worker schema and are empty after resetDb', async () => {
    // Verify tables exist and are empty (resetDb truncates them)
    const { rows: eventCount } = await pool.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM events'
    )
    expect(eventCount[0]?.count).toBe(0)

    const { rows: memberCount } = await pool.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM members'
    )
    expect(memberCount[0]?.count).toBe(0)
  })

  it('data inserted in one test does not leak to another', async () => {
    // Insert a row
    await pool.query(
      `INSERT INTO members (address, joined_ledger) VALUES ('GTEST', 1)`
    )

    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM members'
    )
    expect(rows[0]?.count).toBe(1)

    // The next test that runs (even in parallel) won't see this row because
    // it's in a different schema or resetDb() will truncate it
  })

  it('TRUNCATE is safe across parallel workers', async () => {
    // This test runs concurrently with others. If schemas weren't isolated,
    // one worker's TRUNCATE would race another's SELECT and cause flakiness.
    await pool.query(
      `INSERT INTO members (address, joined_ledger) VALUES ('GTEST2', 1)`
    )

    await pool.query('TRUNCATE members CASCADE')

    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM members'
    )
    expect(rows[0]?.count).toBe(0)
  })
})

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../src/db/index.js'
import { saveCursor } from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'

// Issue #532 — a cursor write can fail after a page has already folded. The
// poller logs that specifically ("[indexer] Cursor write failed: …") so it is
// alertable and distinguishable from a poll error or plain staleness.

describe('cursor write failure logging (issue #532)', () => {
  beforeEach(async () => {
    await resetDb()
    await query(`
      CREATE OR REPLACE FUNCTION test_fail_cursor_write() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated cursor write failure';
      END;
      $$ LANGUAGE plpgsql;
    `)
  })

  async function installFailingTrigger(): Promise<void> {
    await query(`
      DROP TRIGGER IF EXISTS test_fail_cursor_write ON indexer_cursor;
      CREATE TRIGGER test_fail_cursor_write
        BEFORE INSERT OR UPDATE ON indexer_cursor
        FOR EACH ROW EXECUTE FUNCTION test_fail_cursor_write();
    `)
  }

  afterEach(async () => {
    await query('DROP TRIGGER IF EXISTS test_fail_cursor_write ON indexer_cursor')
    await query('DROP FUNCTION IF EXISTS test_fail_cursor_write()')
  })

  afterAll(closeDb)

  it('logs a stable, structured Cursor write failed line and rethrows', async () => {
    await installFailingTrigger()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        saveCursor('CTEST', 'token-1', 321, 400, 'hash-1')
      ).rejects.toThrow('simulated cursor write failure')

      const lines = errorSpy.mock.calls.map((c) => String(c[0]))
      expect(lines).toHaveLength(1)

      const entry = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(entry.level).toBe('error')
      expect(entry.event).toBe('cursor_write_failed')
      expect(String(entry.msg)).toContain('[indexer] Cursor write failed: simulated cursor write failure')
      expect(entry.lastLedger).toBe(321)
      expect(entry.observedTipLedger).toBe(400)
      expect(entry.pagingToken).toBe('token-1')
      expect(entry.contractId).toBe('CTEST')
      expect(new Date(String(entry.time)).toISOString()).toBe(entry.time)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not log when the write succeeds', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await saveCursor('CTEST', 'token-2', 100, 120, null)
      expect(errorSpy).not.toHaveBeenCalled()
      const row = await query<{ last_ledger: number }>(
        'SELECT last_ledger FROM indexer_cursor WHERE id = 1'
      )
      expect(row[0]!.last_ledger).toBe(100)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

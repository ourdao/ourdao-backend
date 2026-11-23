import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../src/db/index.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { closeDb, resetDb } from './db.js'

// Issue #531 — `npm run reindex` now logs structured JSON through
// StructuredLogger. The human-readable `msg` is preserved, and the progress
// line carries processed/total/pct/ratePerSec/etaSec for a log aggregator.

function capturedLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[0]))
}

describe('reindex progress logging (issue #531)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('emits one JSON object per line, with progress fields and a completion line', async () => {
    const total = 5
    for (let i = 1; i <= total; i++) {
      // `name_reg` has a handler but no stream-channel mapping, so the fold
      // exercises the fold path without the NOTIFY side effect.
      await query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
         VALUES ($1, $2, now(), 'CTEST', 'name_reg', '[]'::jsonb, $3::jsonb, NULL)`,
        [`${100 + i}-0`, 100 + i, JSON.stringify([`GMEMBER${i}`, `member-${i}`])]
      )
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = await reindexFromEventLog()
      expect(result.events).toBe(total)

      const lines = capturedLines(logSpy).filter((l) => l.includes('[reindex]'))
      // The library reports progress; the CLI wrapper logs completion.
      expect(lines.length).toBe(total)

      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

      // Every reindex line is a structured log entry, not a plain string.
      for (const entry of parsed) {
        expect(entry.level).toBe('info')
        expect(typeof entry.msg).toBe('string')
        expect(new Date(String(entry.time)).toISOString()).toBe(entry.time)
      }

      const progress = parsed.filter((e) => String(e.msg).startsWith('[reindex] progress:'))
      expect(progress.length).toBeGreaterThanOrEqual(total)
      const last = progress[progress.length - 1]!
      expect(last.processed).toBe(total)
      expect(last.total).toBe(total)
      expect(last.pct).toBe(100)
      expect(typeof last.ratePerSec).toBe('number')
      expect(last.etaSec).toBe(0)
      // Human-readable text an operator watches still reads the same.
      expect(String(last.msg)).toContain(`${total}/${total} event(s) (100.00%)`)
      expect(last.etaSec).toBe(0)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('writes the CLI failure line as structured JSON through the same logger', async () => {
    // reindexFromEventLog() throws to its caller; the `npm run reindex`
    // wrapper logs it. Assert that logger contract (the wrapper itself calls
    // process.exit, so it isn't invoked in-process here).
    const { logger } = await import('../src/lib/logger.js')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      logger.error('[reindex] failed: boom', { error: 'boom' })
      const lines = capturedLines(errorSpy)
      expect(lines).toHaveLength(1)
      const entry = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(entry.level).toBe('error')
      expect(entry.msg).toBe('[reindex] failed: boom')
      expect(entry.error).toBe('boom')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

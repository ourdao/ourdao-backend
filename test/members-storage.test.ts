import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #514 — the members table gets the same measured review the events
// log has (docs/events-storage.md). These tests pin the storage shape the
// document models and the measured recommendation, so a future schema change
// (or a rewritten document) has to be deliberate.

const docPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/members-storage.md')

describe('members — storage shape is pinned (issue #514)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('has exactly the documented columns', async () => {
    const cols = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'members' ORDER BY ordinal_position`
    )
    expect(cols.map((c) => c.column_name)).toEqual([
      'address',
      'joined_ledger',
      'contribution',
      'exited',
      'exit_share',
      'exited_ledger',
      'pending_claimed',
      'stake',
      'has_active_loan',
      'name',
      'defaults_count',
      'updated_at',
    ])
  })

  it('has only the indexes the review evaluated — no speculative join-order index', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'members' ORDER BY indexname`
    )
    // members_pkey serves point lookups; members_active_idx serves the
    // /api/stats active-member count. docs/members-storage.md recommends the
    // corrected join-order index as its own follow-up migration, not here.
    expect(idx.map((r) => r.indexname)).toEqual(['members_active_idx', 'members_pkey'])
  })

  it('/api/members ordering is the query the document measured', async () => {
    await query(
      `INSERT INTO members (address, joined_ledger, exited) VALUES
       ('GA', 100, false), ('GB', 300, false), ('GC', 200, false),
       ('GEXITED', 400, true), ('GPHANTOM', NULL, false)`
    )
    const rows = await query<{ address: string }>(
      `SELECT address FROM members
        WHERE exited = false AND joined_ledger IS NOT NULL
        ORDER BY joined_ledger DESC NULLS LAST LIMIT 50`
    )
    expect(rows.map((r) => r.address)).toEqual(['GB', 'GC', 'GA'])
  })

  it('document records the measured plan and the corrected-index recommendation', () => {
    const doc = readFileSync(docPath, 'utf8')

    // Row-size and growth model, analogous to docs/events-storage.md.
    expect(doc).toContain('## Row-size model')
    expect(doc).toContain('### Growth per unit of activity')

    // The actual EXPLAIN ANALYZE comparison, including the finding that the
    // issue's candidate (DESC without NULLS LAST) cannot satisfy the query.
    expect(doc).toContain('EXPLAIN (ANALYZE, FORMAT JSON)')
    expect(doc).toContain('(exited, joined_ledger DESC)')
    expect(doc).toContain('DESC NULLS LAST')
    expect(doc).toContain('does not work')
    expect(doc).toContain('Seq Scan')
    expect(doc).toContain('Index Scan')
    expect(doc).toMatch(/307\.6 ms/)

    // A recommendation and a revisit threshold, not just a plan dump.
    expect(doc).toContain('## Recommendation')
    expect(doc).toContain('### Revisit threshold')
    expect(doc).toContain('members_join_order_idx')
  })
})

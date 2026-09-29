import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { pool } from '../src/db/index.js'
import { breakingReasons, checkMigration, parseCompat } from '../src/db/migration-policy.js'
import { closeDb } from './db.js'

afterAll(closeDb)

const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations')

async function migrations(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })))
}

describe('migration reversibility policy (issue #197)', () => {
  it('every migration declares its compatibility and conforms to the policy', async () => {
    const violations = (await migrations()).flatMap(({ name, sql }) => checkMigration(name, sql))
    expect(violations).toEqual([])
  })

  it('the audited set of breaking migrations is exactly the documented one', async () => {
    const breaking = (await migrations())
      .filter(({ sql }) => parseCompat(sql)?.kind === 'breaking')
      .map(({ name }) => name.slice(0, 4))
    // Keep in sync with docs/DEPLOYMENT.md "Rolling back a bad deploy".
    expect(breaking).toEqual(['0001', '0012', '0017', '0022'])
  })

  it('rejects a missing annotation and an unannotated destructive change', () => {
    expect(checkMigration('0099_x.sql', 'ALTER TABLE t ADD COLUMN c INT;')).toHaveLength(1)
    expect(
      checkMigration('0099_x.sql', '-- compat: backward-compatible\nALTER TABLE t DROP COLUMN c;')
    ).toHaveLength(1)
    expect(
      checkMigration('0099_x.sql', '-- compat: backward-compatible\nALTER TABLE t ALTER COLUMN c TYPE BIGINT;')
    ).toHaveLength(1)
    expect(
      checkMigration('0099_x.sql', '-- compat: backward-compatible\nALTER TABLE t ADD CONSTRAINT k CHECK (c > 0);')
    ).toHaveLength(1)
  })

  it('accepts additive changes and an honestly annotated breaking one', () => {
    const additive = '-- compat: backward-compatible\nALTER TABLE t ADD COLUMN c INT NOT NULL DEFAULT 0;\nCREATE INDEX i ON t (c);'
    expect(checkMigration('0099_x.sql', additive)).toEqual([])
    expect(breakingReasons('-- ALTER TABLE t DROP COLUMN c;\nSELECT 1;')).toEqual([])
    expect(
      checkMigration('0099_x.sql', '-- compat: breaking (drops c)\nALTER TABLE t DROP COLUMN c;')
    ).toEqual([])
  })

  it('every migration file is recorded in schema_migrations with a unique version', async () => {
    const files = await migrations()
    const { rows } = await pool.query<{ version: number }>('SELECT version FROM schema_migrations')
    const recorded = new Set(rows.map((r) => r.version))
    for (const { name } of files) expect(recorded.has(Number.parseInt(name.slice(0, 4), 10)), name).toBe(true)
  })
})

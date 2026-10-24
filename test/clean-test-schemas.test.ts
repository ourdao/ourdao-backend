import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEST_DATABASE_URL,
  LIST_TEST_SCHEMAS_SQL,
  cleanTestSchemas,
  parseCleanArgs,
  resolveCleanupDatabaseUrl,
  type QueryablePool,
} from '../scripts/clean-test-schemas.js'

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/clean-test-schemas.ts'
)

describe('scripts/clean-test-schemas.ts (#416)', () => {
  it('header comment warns not to run while tests are active instead of claiming mid-run safety', async () => {
    const source = await readFile(SCRIPT_PATH, 'utf8')
    const header = source.slice(0, source.indexOf('import '))

    expect(header).not.toMatch(/Safe to run at any time/i)
    expect(header).not.toMatch(/recreate their\s*\n\s*\*\s*schemas as needed/i)
    expect(header).toMatch(/Do NOT run this script while `npm test` is running/)
  })

  it('escapes underscores in the information_schema LIKE pattern', () => {
    expect(LIST_TEST_SCHEMAS_SQL).toContain("LIKE 'test\\_worker\\_%' ESCAPE '\\'")
  })

  it('refuses to run against a non-test DATABASE_URL', () => {
    expect(() =>
      resolveCleanupDatabaseUrl({
        DATABASE_URL: 'postgres://ourdao:ourdao@prod.internal:5432/ourdao_prod',
      })
    ).toThrow(/Refusing to clean test schemas/)

    expect(() =>
      resolveCleanupDatabaseUrl({
        DATABASE_URL: 'postgres://ourdao:ourdao@localhost:5432/ourdao_dev',
        TEST_DATABASE_URL: DEFAULT_TEST_DATABASE_URL,
      })
    ).toThrow(/does not match TEST_DATABASE_URL/)

    expect(() =>
      resolveCleanupDatabaseUrl({
        TEST_DATABASE_URL: 'postgres://ourdao:ourdao@localhost:5432/production',
      })
    ).toThrow(/is not a test database/)
  })

  it('accepts a matching TEST_DATABASE_URL or default test database', () => {
    expect(resolveCleanupDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL)
    expect(
      resolveCleanupDatabaseUrl({
        DATABASE_URL: DEFAULT_TEST_DATABASE_URL,
        TEST_DATABASE_URL: DEFAULT_TEST_DATABASE_URL,
      })
    ).toBe(DEFAULT_TEST_DATABASE_URL)
  })

  it('refuses to drop schemas when active test sessions exist unless --force is passed', async () => {
    const queries: string[] = []
    const mockDb: QueryablePool = {
      async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        queries.push(sql)
        if (sql.includes('pg_stat_activity')) {
          return { rows: [{ pid: 1234 } as unknown as T] }
        }
        if (sql.includes('information_schema.schemata')) {
          return {
            rows: [{ schema_name: 'test_worker_1' } as unknown as T],
          }
        }
        return { rows: [] }
      },
      async end() {},
    }

    await expect(cleanTestSchemas(mockDb, { force: false })).rejects.toThrow(
      /active session/
    )

    const dropped = await cleanTestSchemas(mockDb, { force: true })
    expect(dropped).toEqual(['test_worker_1'])
    expect(queries.some((q) => q.includes('DROP SCHEMA IF EXISTS "test_worker_1" CASCADE'))).toBe(
      true
    )
  })

  it('parses --force and rejects unknown flags', () => {
    expect(parseCleanArgs([])).toEqual({ force: false })
    expect(parseCleanArgs(['--force'])).toEqual({ force: true })
    expect(() => parseCleanArgs(['--unknown'])).toThrow(/Unknown option/)
  })
})

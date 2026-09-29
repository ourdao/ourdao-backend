import { afterAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { exemptTransactionFromStatementTimeout, pool } from '../src/db/index.js'
import { closeDb } from './db.js'

// Issue #196: pool sizing, timeouts and application_name are configurable and
// actually reach the pool / Postgres.
describe('pg pool configuration', () => {
  afterAll(closeDb)

  it('resolveConfig reads every pool knob from the environment', () => {
    const c = resolveConfig({
      DB_POOL_MAX: '4',
      DB_CONNECTION_TIMEOUT_MS: '1500',
      DB_STATEMENT_TIMEOUT_MS: '2500',
      DB_IDLE_TIMEOUT_MS: '7000',
      DB_APPLICATION_NAME: 'custom-name',
    })
    expect(c.db.poolMax).toBe(4)
    expect(c.db.connectionTimeoutMs).toBe(1500)
    expect(c.db.statementTimeoutMs).toBe(2500)
    expect(c.db.idleTimeoutMs).toBe(7000)
    expect(c.db.applicationName).toBe('custom-name')
  })

  it('has documented defaults', () => {
    const c = resolveConfig({})
    expect(c.db.poolMax).toBe(10)
    expect(c.db.connectionTimeoutMs).toBe(5000)
    expect(c.db.statementTimeoutMs).toBe(10_000)
    expect(c.db.idleTimeoutMs).toBe(30_000)
  })

  it('names the connection after the process role unless overridden', () => {
    expect(resolveConfig({}).db.applicationName).toBe('ourdao-api')
    expect(resolveConfig({ OURDAO_PROCESS_ROLE: 'worker' }).db.applicationName).toBe('ourdao-worker')
    expect(resolveConfig({ OURDAO_PROCESS_ROLE: 'worker', DB_APPLICATION_NAME: 'x' }).db.applicationName).toBe('x')
  })

  it('configured values reach the pool and the Postgres session', async () => {
    const opts = pool.options as unknown as Record<string, unknown>
    const { config } = await import('../src/config.js')
    expect(opts.max).toBe(config.db.poolMax)
    expect(opts.connectionTimeoutMillis).toBe(config.db.connectionTimeoutMs)
    expect(opts.idleTimeoutMillis).toBe(config.db.idleTimeoutMs)

    const { rows } = await pool.query<{ app: string; timeout: string; self: string }>(
      `SELECT current_setting('application_name') AS app,
              current_setting('statement_timeout') AS timeout,
              application_name AS self
         FROM pg_stat_activity WHERE pid = pg_backend_pid()`
    )
    expect(rows[0]!.app).toBe(config.db.applicationName)
    expect(rows[0]!.self).toBe(config.db.applicationName)
    expect(rows[0]!.timeout).toBe(`${config.db.statementTimeoutMs / 1000}s`)
  })

  it('the pooled statement_timeout kills a slow statement', async () => {
    const client = await pool.connect()
    try {
      await client.query('SET statement_timeout = 50')
      await expect(client.query('SELECT pg_sleep(1)')).rejects.toThrow(/statement timeout/)
    } finally {
      await client.query('RESET statement_timeout')
      client.release()
    }
  })

  it('exemptTransactionFromStatementTimeout lifts the limit for one transaction only', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await exemptTransactionFromStatementTimeout(client, 'ourdao-reindex')
      const inside = await client.query(
        `SELECT current_setting('statement_timeout') AS t, current_setting('application_name') AS a`
      )
      expect(inside.rows[0]).toEqual({ t: '0', a: 'ourdao-reindex' })
      await client.query('COMMIT')
      const after = await client.query(
        `SELECT current_setting('statement_timeout') AS t, current_setting('application_name') AS a`
      )
      expect(after.rows[0]!.t).not.toBe('0')
      expect(after.rows[0]!.a).not.toBe('ourdao-reindex')
    } finally {
      client.release()
    }
  })
})

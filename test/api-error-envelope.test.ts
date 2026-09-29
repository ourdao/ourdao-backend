import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { classifyError, codeForStatus, ERROR_CODES } from '../src/api/errors.js'
import { pool } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const PG_TEXT = /invalid input syntax|out of range|for type integer|violates|constraint|SELECT |FROM |\.ts:\d+/i

describe('API: single error envelope (#81)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('a thrown database error returns the standard shape with no Postgres text', async () => {
    // proposal_id passes the route's `/^[0-9]+$/` check but overflows the
    // INTEGER column — Postgres throws 22003. Before the error handler this
    // reached the client as {"statusCode":500,...,"message":"...out of range
    // for type integer..."}.
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents?kind=loan&proposal_id=99999999999',
    })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal server error', code: 'INTERNAL_ERROR', correlationId: expect.any(String) })
    expect(res.payload).not.toMatch(PG_TEXT)
    expect(res.json()).not.toHaveProperty('message')
    expect(res.json()).not.toHaveProperty('stack')
  })

  it('a deliberate 404 keeps its message and gains a code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/loans/999999999' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'loan not found', code: 'NOT_FOUND', correlationId: expect.any(String) })
  })

  it('a deliberate 400 keeps its message and gains a code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/loans/abc' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid loan id', code: 'BAD_REQUEST', correlationId: expect.any(String) })
  })

  it('an unmatched route returns the envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'route not found', code: 'ROUTE_NOT_FOUND', correlationId: expect.any(String) })
  })

  it('the correlation id appears in both the response and the log line', async () => {
    const lines: string[] = []
    const capturing = await buildServer({
      logger: { level: 'error', stream: { write: (s: string) => void lines.push(s) } },
    })
    await capturing.ready()
    try {
      const res = await capturing.inject({
        method: 'GET',
        url: '/api/documents?kind=loan&proposal_id=99999999999',
      })
      const id = res.json().correlationId as string

      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.headers['x-correlation-id']).toBe(id)

      const logged = lines.find((l) => l.includes(id))
      expect(logged, 'a log line should carry the correlation id').toBeTruthy()
      // Full detail is server-side only.
      expect(logged).toMatch(/out of range|22003/i)
      expect(res.payload).not.toMatch(PG_TEXT)
    } finally {
      await capturing.close()
    }
  })

  it('maps specific pg errors to sensible statuses (not an opaque 500)', async () => {
    const cases: Array<[string, number, string]> = [
      ['23505', 409, 'RESOURCE_ALREADY_EXISTS'], // unique_violation
      ['23514', 422, 'CONSTRAINT_VIOLATION'], // check_violation
      ['57P03', 503, 'DATABASE_UNAVAILABLE'], // cannot_connect_now
      ['ECONNREFUSED', 503, 'DATABASE_UNAVAILABLE'], // socket errno, no SQLSTATE yet
    ]
    for (const [code, status, envelopeCode] of cases) {
      const err = Object.assign(new Error(`pg says: relation "loans_pkey" ... ${code}`), { code })
      const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(err)
      try {
        const res = await app.inject({ method: 'GET', url: '/api/members' })
        expect(res.statusCode, code).toBe(status)
        expect(res.json()).toHaveProperty('error')
        expect(res.json()).toHaveProperty('correlationId')
        expect(res.json().code, code).toBe(envelopeCode)
        expect(res.payload, code).not.toMatch(/loans_pkey/)
      } finally {
        spy.mockRestore()
      }
    }
  })
})

describe('classifyError (#81)', () => {
  it('keeps deliberate 4xx messages, hides 5xx and pg detail', () => {
    expect(classifyError(Object.assign(new Error('bad'), { statusCode: 400 })))
      .toEqual({ status: 400, error: 'bad', code: 'BAD_REQUEST', leak: false })

    expect(classifyError(Object.assign(new Error('field x is required'), { validation: [{}], statusCode: 400 })))
      .toEqual({ status: 400, error: 'field x is required', code: 'VALIDATION_FAILED', leak: false })

    expect(classifyError(new Error('boom')))
      .toEqual({ status: 500, error: 'internal server error', code: 'INTERNAL_ERROR', leak: true })

    expect(classifyError(Object.assign(new Error('invalid input syntax for type integer: "NaN"'), { code: '22P02' })))
      .toEqual({ status: 500, error: 'internal server error', code: 'INTERNAL_ERROR', leak: true })

    expect(classifyError(Object.assign(new Error('dup'), { code: '23505' })))
      .toEqual({ status: 409, error: 'resource already exists', code: 'RESOURCE_ALREADY_EXISTS', leak: true })

    expect(classifyError(Object.assign(new Error('down'), { code: '08006' })))
      .toEqual({ status: 503, error: 'database temporarily unavailable', code: 'DATABASE_UNAVAILABLE', leak: true })
  })
})

describe('error codes (#186)', () => {
  beforeEach(resetDb)

  // Real driver errors from the test Postgres, not hand-built objects, so a
  // change in how pg surfaces SQLSTATEs is caught too.
  async function pgError(sql: string, params: unknown[] = []): Promise<unknown> {
    try {
      await pool.query(sql, params)
    } catch (err) {
      return err
    }
    throw new Error(`expected ${sql} to fail`)
  }

  it('every classifyError branch produces its documented code, from real Postgres errors', async () => {
    await pool.query(`INSERT INTO members (address) VALUES ('GDUP')`)
    const unique = await pgError(`INSERT INTO members (address) VALUES ('GDUP')`)
    const check = await pgError(
      `INSERT INTO loans (id, borrower, amount, status) VALUES (1, 'G', 1, 'not-a-status')`
    )
    const notNull = await pgError(`INSERT INTO members (address) VALUES (NULL)`)
    const otherSqlstate = await pgError(`SELECT 'x'::int`)

    const cases: Array<[unknown, number, string]> = [
      [unique, 409, 'RESOURCE_ALREADY_EXISTS'],
      [check, 422, 'CONSTRAINT_VIOLATION'],
      [notNull, 422, 'MISSING_REQUIRED_VALUE'],
      [otherSqlstate, 500, 'INTERNAL_ERROR'],
      [Object.assign(new Error('fk'), { code: '23503' }), 409, 'RELATED_DATA_CONFLICT'],
      [Object.assign(new Error('down'), { code: '57P01' }), 503, 'DATABASE_UNAVAILABLE'],
      [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 503, 'DATABASE_UNAVAILABLE'],
      [Object.assign(new Error('x is required'), { validation: [{}], statusCode: 400 }), 400, 'VALIDATION_FAILED'],
      [Object.assign(new Error('nope'), { statusCode: 403 }), 403, 'FORBIDDEN'],
      [Object.assign(new Error('too big'), { statusCode: 413 }), 413, 'PAYLOAD_TOO_LARGE'],
      [Object.assign(new Error('teapot'), { statusCode: 418 }), 418, 'CLIENT_ERROR'],
      [Object.assign(new Error('bad gateway'), { statusCode: 502 }), 502, 'INTERNAL_ERROR'],
      [new Error('boom'), 500, 'INTERNAL_ERROR'],
    ]
    for (const [err, status, code] of cases) {
      const got = classifyError(err)
      expect({ status: got.status, code: got.code }, String((err as Error).message)).toEqual({ status, code })
      expect(ERROR_CODES).toContain(got.code)
    }
  })

  it('codeForStatus only ever returns a documented code', () => {
    for (let s = 400; s < 600; s++) expect(ERROR_CODES).toContain(codeForStatus(s))
  })

  it('codes are documented in the README Errors section', async () => {
    const { readFileSync } = await import('node:fs')
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    for (const code of ERROR_CODES) expect(readme, code).toContain(`\`${code}\``)
  })

  it('a rate-limited response carries RATE_LIMITED', async () => {
    const { buildServer: build } = await import('../src/api/server.js')
    const app = await build()
    await app.ready()
    try {
      let res = await app.inject({ method: 'GET', url: '/api/members' })
      for (let i = 0; i < 500 && res.statusCode !== 429; i++) {
        res = await app.inject({ method: 'GET', url: '/api/members' })
      }
      expect(res.statusCode).toBe(429)
      expect(res.json()).toMatchObject({ code: 'RATE_LIMITED', correlationId: expect.any(String) })
    } finally {
      await app.close()
    }
  })
})

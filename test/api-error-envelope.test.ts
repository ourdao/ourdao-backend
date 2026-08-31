import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { classifyError } from '../src/api/errors.js'
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
    expect(res.json()).toEqual({ error: 'internal server error', correlationId: expect.any(String) })
    expect(res.payload).not.toMatch(PG_TEXT)
    expect(res.json()).not.toHaveProperty('message')
    expect(res.json()).not.toHaveProperty('stack')
  })

  it('a deliberate 404 is unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/loans/999999999' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'loan not found' })
  })

  it('a deliberate 400 is unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/loans/abc' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid loan id' })
  })

  it('an unmatched route returns the envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'route not found', correlationId: expect.any(String) })
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
    const cases: Array<[string, number]> = [
      ['23505', 409], // unique_violation
      ['23514', 422], // check_violation
      ['57P03', 503], // cannot_connect_now
      ['ECONNREFUSED', 503], // socket errno, no SQLSTATE yet
    ]
    for (const [code, status] of cases) {
      const err = Object.assign(new Error(`pg says: relation "loans_pkey" ... ${code}`), { code })
      const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(err)
      try {
        const res = await app.inject({ method: 'GET', url: '/api/members' })
        expect(res.statusCode, code).toBe(status)
        expect(res.json()).toHaveProperty('error')
        expect(res.json()).toHaveProperty('correlationId')
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
      .toEqual({ status: 400, error: 'bad', leak: false })

    expect(classifyError(Object.assign(new Error('field x is required'), { validation: [{}], statusCode: 400 })))
      .toEqual({ status: 400, error: 'field x is required', leak: false })

    expect(classifyError(new Error('boom')))
      .toEqual({ status: 500, error: 'internal server error', leak: true })

    expect(classifyError(Object.assign(new Error('invalid input syntax for type integer: "NaN"'), { code: '22P02' })))
      .toEqual({ status: 500, error: 'internal server error', leak: true })

    expect(classifyError(Object.assign(new Error('dup'), { code: '23505' })))
      .toEqual({ status: 409, error: 'resource already exists', leak: true })

    expect(classifyError(Object.assign(new Error('down'), { code: '08006' })))
      .toEqual({ status: 503, error: 'database temporarily unavailable', leak: true })
  })
})

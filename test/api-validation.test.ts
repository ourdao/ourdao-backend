import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { pool } from '../src/db/index.js'
import { resetDb } from './db.js'

const VALID_ADDRESS = Keypair.random().publicKey()

describe('API: pagination and path validation (#54, #55)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  it.each([
    '/api/members',
    '/api/proposals/loan',
    '/api/loans',
    '/api/proposals/treasury',
    `/api/notifications?address=${VALID_ADDRESS}`,
    '/api/events',
    '/api/admin/log',
    '/api/admin/failed-events',
    '/api/interest',
  ])('rejects invalid limit parameter on %s with 400', async (path) => {
    const spy = vi.spyOn(pool, 'query')
    try {
      for (const value of ['abc', '-5', '99999', '50abc', '0']) {
        const res = await app.inject({ method: 'GET', url: `${path}${path.includes('?') ? '&' : '?'}limit=${value}` })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toHaveProperty('error')
        expect(spy).not.toHaveBeenCalled()
      }
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['/api/loans', '/api/events', '/api/interest', '/api/documents'])(
    'rejects malformed cursors on %s before querying',
    async (path) => {
      const spy = vi.spyOn(pool, 'query')
      try {
        const res = await app.inject({ method: 'GET', url: `${path}?before=not-a-number` })
        expect(res.statusCode).toBe(400)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    }
  )

  it('rejects invalid member addresses before querying', async () => {
    const spy = vi.spyOn(pool, 'query')
    try {
      const res = await app.inject({ method: 'GET', url: '/api/members/not-a-stellar-address' })
      expect(res.statusCode).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects invalid borrower query parameter on /api/loans', async () => {
    const spy = vi.spyOn(pool, 'query')
    try {
      const res = await app.inject({ method: 'GET', url: '/api/loans?borrower=not-a-stellar-address' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid Stellar address', code: 'BAD_REQUEST', correlationId: expect.any(String) })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['/api/loans/not-a-number', '/api/loans/-1', '/api/loans/1.5'])(
    'rejects invalid numeric path parameters on %s',
    async (path) => {
      const spy = vi.spyOn(pool, 'query')
      try {
        const res = await app.inject({ method: 'GET', url: path })
        expect(res.statusCode).toBe(400)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    }
  )
})

describe('API: fail-soft readiness', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildServer()
    await app.ready()
  })

  it('returns 503 when the readiness database query fails', async () => {
    const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database unavailable'))
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'not ready', reason: 'postgres_unreachable' })
    } finally {
      spy.mockRestore()
    }
  })

  // Issue #347: only a missing table (SQLSTATE 42P01) is a cold start. Every
  // other cursor/halt read failure must report 503 instead of `ready`.
  it('returns 503 postgres_error when the indexer cursor query fails for a non-missing-table reason', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    const spy = vi
      .spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] } as never) // SELECT 1
      .mockRejectedValueOnce(timeout) // indexer_cursor
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ status: 'not ready', reason: 'postgres_error' })
    } finally {
      spy.mockRestore()
    }
  })

  it('returns 503 postgres_error when the reorg halt query fails, rather than hiding a recorded halt (issue #347)', async () => {
    const denied = Object.assign(new Error('permission denied for table reorg_halts'), { code: '42501' })
    const spy = vi
      .spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] } as never) // SELECT 1
      .mockResolvedValueOnce({ rows: [{ last_ledger: 100, observed_tip_ledger: 100, updated_at: new Date().toISOString() }] } as never) // indexer_cursor
      .mockRejectedValueOnce(denied) // reorg_halts
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ status: 'not ready', reason: 'postgres_error' })
    } finally {
      spy.mockRestore()
    }
  })

  it('still treats genuinely missing tables as a cold start (issue #347)', async () => {
    const undefinedTable = Object.assign(new Error('relation "indexer_cursor" does not exist'), { code: '42P01' })
    const spy = vi
      .spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] } as never) // SELECT 1
      .mockRejectedValueOnce(undefinedTable) // indexer_cursor
      .mockRejectedValueOnce(undefinedTable) // reorg_halts
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ready', indexer: 'cold_start' })
    } finally {
      spy.mockRestore()
    }
  })
})

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: ETags and Caching', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    
    // Seed some data
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES ('GAOEMNVGFX7CXSGGFLMXCWYB4UPJLOZ2NLSHS3OMR2MFI6OJ2YWDYJTI', 100, '5000', '1000', false)
    `)
  })
  afterAll(closeDb)

  it('GET /api/members returns ETag and 304 on If-None-Match', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/members' })
    expect(res1.statusCode).toBe(200)
    const etag = res1.headers.etag
    expect(etag).toBeTruthy()

    const res2 = await app.inject({ 
      method: 'GET', 
      url: '/api/members',
      headers: { 'if-none-match': etag as string }
    })
    expect(res2.statusCode).toBe(304)
    expect(res2.body).toBe('')

    // Modify data
    await query(`
      INSERT INTO members (address, joined_ledger, contribution, stake, exited)
      VALUES ('GD2XX', 101, '1000', '100', false)
    `)

    const res3 = await app.inject({ 
      method: 'GET', 
      url: '/api/members',
      headers: { 'if-none-match': etag as string }
    })
    expect(res3.statusCode).toBe(200)
    expect(res3.headers.etag).not.toBe(etag)
  })

  it('sets correct Cache-Control for historical queries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?before=100' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('sets correct Cache-Control for live tip queries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=5, must-revalidate')
  })
  
  it('sets private no-cache for per-address queries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications?address=GAOEMNVGFX7CXSGGFLMXCWYB4UPJLOZ2NLSHS3OMR2MFI6OJ2YWDYJTI' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-cache')
  })
})

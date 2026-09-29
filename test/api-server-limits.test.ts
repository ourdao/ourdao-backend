// Issue #187: server timeouts and body/param limits are set deliberately,
// not inherited from Fastify's defaults.
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer, MAX_PARAM_LENGTH } from '../src/api/server.js'
import { config } from '../src/config.js'
import { closeDb, resetDb } from './db.js'

afterAll(closeDb)

describe('server limits (#187)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
  })
  afterEach(async () => {
    await app?.close()
  })

  it('applies the configured limits instead of Fastify/Node defaults', async () => {
    app = await buildServer()
    await app.ready()
    expect(app.initialConfig.bodyLimit).toBe(config.http.bodyLimitBytes)
    expect(app.initialConfig.bodyLimit).toBeLessThan(1024 * 1024)
    expect(app.server.requestTimeout).toBe(config.http.requestTimeoutMs)
    expect(app.server.requestTimeout).toBeGreaterThan(0)
    expect(app.server.timeout).toBe(config.http.connectionTimeoutMs)
    // Above the 30s SSE heartbeat, so a healthy idle stream is never cut.
    expect(app.server.timeout).toBeGreaterThan(30_000)
    expect(app.server.keepAliveTimeout).toBe(config.http.keepAliveTimeoutMs)
  })

  it('rejects an oversized body with 413 PAYLOAD_TOO_LARGE', async () => {
    app = await buildServer()
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/read-all',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(config.http.bodyLimitBytes) }),
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', correlationId: expect.any(String) })
  })

  it('closes a stalled (never-completed) request with 408 REQUEST_TIMEOUT within a bounded time', async () => {
    app = await buildServer({
      // Node checks request timeouts on an interval (30s by default); shrink
      // both so the test can wait it out.
      serverOptions: { requestTimeout: 300, http: { connectionsCheckingInterval: 50 } },
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo

    const started = Date.now()
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        // Headers never terminated — a slow-loris style partial request.
        socket.write('GET /api/members HTTP/1.1\r\nHost: localhost\r\n')
      })
      let data = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('stalled request was never closed'))
      }, 5_000)
      socket.on('data', (chunk) => (data += chunk.toString()))
      socket.on('close', () => {
        clearTimeout(timer)
        resolve(data)
      })
      socket.on('error', reject)
    })

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(response).toMatch(/^HTTP\/1\.1 408 /)
    const body = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>
    expect(body).toMatchObject({ code: 'REQUEST_TIMEOUT', correlationId: expect.any(String) })
  })

  it('path-parameter limit fits every parameter the API accepts, and is pinned', async () => {
    app = await buildServer()
    await app.ready()
    const address = Keypair.random().publicKey()
    expect(address).toHaveLength(56)
    expect(MAX_PARAM_LENGTH).toBe(100)

    // Longest legitimate parameters reach their handler (entity 404, not a
    // router rejection).
    const member = await app.inject({ method: 'GET', url: `/api/members/${address}` })
    expect(member.json()).toMatchObject({ code: 'NOT_FOUND', error: 'member not found' })
    const loan = await app.inject({ method: 'GET', url: '/api/loans/2147483647' })
    expect(loan.json()).toMatchObject({ code: 'NOT_FOUND' })

    // Exactly at the limit still routes; one past it is rejected by the router.
    const atLimit = await app.inject({ method: 'GET', url: `/api/members/${'G'.repeat(MAX_PARAM_LENGTH)}` })
    expect(atLimit.statusCode).toBe(400)
    expect(atLimit.json()).toMatchObject({ error: 'invalid Stellar address' })
    const overLimit = await app.inject({ method: 'GET', url: `/api/members/${'G'.repeat(MAX_PARAM_LENGTH + 1)}` })
    expect(overLimit.statusCode).toBe(414)
    expect(overLimit.json()).toMatchObject({ code: 'CLIENT_ERROR', correlationId: expect.any(String) })
  })
})

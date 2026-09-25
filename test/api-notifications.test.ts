import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

const keypair = Keypair.random()
const address = keypair.publicKey()

async function authHeader(app: FastifyInstance): Promise<string> {
  const challenge = await app.inject({ method: 'GET', url: `/api/auth/challenge?address=${address}` })
  const nonce = challenge.json().nonce as string
  const signature = keypair.sign(Buffer.from(`${nonce}:${address}`)).toString('base64')
  return `StellarSignature ${address}:${signature}:${nonce}`
}

describe('API: notification mutations', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('GET /api/notifications requires an address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications' })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH /api/notifications/:id/read marks that row read and 404s for a missing id', async () => {
    const [row] = await query<{ id: number }>(
      `INSERT INTO notifications (address, type, title, message) VALUES ($1, 'info', 't', 'm') RETURNING id`,
      [address]
    )
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/${row!.id}/read`,
      headers: { authorization: await authHeader(app) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().read).toBe(true)

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/999999/read',
      headers: { authorization: await authHeader(app) },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('PATCH /api/notifications/:id/read 400s on a non-numeric id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/not-a-number/read',
      headers: { authorization: await authHeader(app) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH /api/notifications/read-all marks only that address unread rows as read', async () => {
    await query(
      `INSERT INTO notifications (address, type, title, message, read) VALUES
       ($1, 'info', 't1', 'm1', false),
       ($1, 'info', 't2', 'm2', false),
       ($1, 'info', 't3', 'm3', true),
       ('GB', 'info', 't4', 'm4', false)`,
      [address]
    )
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/read-all?address=${address}`,
      headers: { authorization: await authHeader(app) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().updated).toBe(2)

    const ga = await query<{ read: boolean }>('SELECT read FROM notifications WHERE address = $1', [address])
    expect(ga.every((n) => n.read)).toBe(true)

    const gb = await query<{ read: boolean }>('SELECT read FROM notifications WHERE address = $1', ['GB'])
    expect(gb[0]?.read).toBe(false)
  })

  it('PATCH /api/notifications/read-all requires an address', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/notifications/read-all' })
    expect(res.statusCode).toBe(400)
  })

  // Issue #134: acting on another member's notifications must fail the same
  // way — 403, not a mix of 401/403 — regardless of which route rejects it.
  it('rejects acting on another address\'s notifications with 403 on both routes', async () => {
    const other = Keypair.random().publicKey()

    const [row] = await query<{ id: number }>(
      `INSERT INTO notifications (address, type, title, message) VALUES ($1, 'info', 't', 'm') RETURNING id`,
      [other]
    )
    const byId = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/${row!.id}/read`,
      headers: { authorization: await authHeader(app) },
    })
    expect(byId.statusCode).toBe(403)

    const readAll = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/read-all?address=${other}`,
      headers: { authorization: await authHeader(app) },
    })
    expect(readAll.statusCode).toBe(403)
  })
})

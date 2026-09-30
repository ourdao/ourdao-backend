import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { CACHE_POLICIES, DEFAULT_CACHE_POLICY, isKnownCacheControl, registerCachePolicy, MAX_CACHE_LIFETIME_SECONDS } from '../src/api/cache-policy.js'
import Fastify from 'fastify'
import { closeDb, resetDb } from './db.js'

const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('no response is cached beyond an incident window (issue #190)', () => {
  const maxAge = (value: string): number | null => {
    const m = /max-age=(\d+)/.exec(value)
    return m ? Number(m[1]) : null
  }

  it('no policy is immutable — nothing carries a URL version to invalidate with', () => {
    for (const value of Object.values(CACHE_POLICIES)) {
      expect(value).not.toMatch(/immutable/)
    }
  })

  it('every max-age is at most one hour and every public policy revalidates', () => {
    for (const value of Object.values(CACHE_POLICIES)) {
      const age = maxAge(value)
      if (age !== null) expect(age).toBeLessThanOrEqual(MAX_CACHE_LIFETIME_SECONDS)
      if (value.startsWith('public')) expect(value).toMatch(/must-revalidate/)
    }
    expect(maxAge(CACHE_POLICIES['public-historical'])).toBe(MAX_CACHE_LIFETIME_SECONDS)
  })
})

describe('cache policies (issue #194)', () => {
  it('no source file outside cache-policy.ts writes a Cache-Control directive', () => {
    const offenders = sourceFiles(srcDir)
      .filter((f) => !f.endsWith('api/cache-policy.ts'))
      .filter((f) => /cache-control/i.test(readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')))
      .map((f) => relative(srcDir, f))
    expect(offenders).toEqual([])
  })

  it('the policy set is closed and no policy is both public and private', () => {
    expect(Object.keys(CACHE_POLICIES).sort()).toEqual(['no-store', 'private', 'public-historical', 'public-live'])
    for (const v of Object.values(CACHE_POLICIES)) {
      expect(!(v.includes('public') && v.includes('private'))).toBe(true)
    }
    expect(DEFAULT_CACHE_POLICY).toBe('no-store')
  })

  it('an ad-hoc directive set by a route is replaced with no-store', async () => {
    const app = Fastify({ logger: false })
    registerCachePolicy(app)
    app.get('/ad-hoc', async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=999')
      return { ok: true }
    })
    app.get('/unset', async () => ({ ok: true }))
    const adHoc = await app.inject({ method: 'GET', url: '/ad-hoc' })
    expect(adHoc.headers['cache-control']).toBe(CACHE_POLICIES['no-store'])
    const unset = await app.inject({ method: 'GET', url: '/unset' })
    expect(unset.headers['cache-control']).toBe(CACHE_POLICIES['no-store'])
    await app.close()
  })
})

describe('every route applies a named policy (issue #194)', () => {
  let app: FastifyInstance
  const ADDR = Keypair.random().publicKey()

  beforeAll(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    await closeDb()
  })

  function concrete(path: string): string {
    return path
      .replace(/\{address\}/g, ADDR)
      .replace(/\{id\}/g, '1')
      .replace(/^(\/api\/documents)$/, '$1?kind=loan&proposal_id=1')
      .replace(/^(\/api\/notifications)$/, `$1?address=${ADDR}`)
  }

  it('every GET route responds with a Cache-Control from the known set', async () => {
    const paths = (app.swagger() as { paths: Record<string, Record<string, unknown>> }).paths
    const gets = Object.entries(paths).filter(([, m]) => 'get' in m).map(([p]) => p)
    expect(gets.length).toBeGreaterThan(10)
    for (const path of gets) {
      if (path === '/api/stream') continue // long-lived; covered in api-stream.test.ts
      const res = await app.inject({ method: 'GET', url: concrete(path) })
      expect(isKnownCacheControl(res.headers['cache-control']), `${path} -> ${res.headers['cache-control']}`).toBe(true)
    }
  })

  it('member-specific endpoints are private, never public', async () => {
    for (const url of [`/api/members/${ADDR}/summary`, `/api/notifications?address=${ADDR}`]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.headers['cache-control'], url).toBe(CACHE_POLICIES.private)
    }
  })

  it('auth challenges, health, readiness, diagnostics and mutations are no-store', async () => {
    const checks: Array<[string, string]> = [
      ['GET', `/api/auth/challenge?address=${ADDR}`],
      ['GET', '/health'],
      ['GET', '/ready'],
      ['GET', '/api/admin/failed-events'],
      ['PATCH', `/api/notifications/read-all?address=${ADDR}`],
      ['PATCH', '/api/notifications/1/read'],
    ]
    for (const [method, url] of checks) {
      const res = await app.inject({ method: method as 'GET' | 'PATCH', url })
      expect(res.headers['cache-control'], `${method} ${url}`).toBe(CACHE_POLICIES['no-store'])
      expect(res.headers.etag, `${method} ${url}`).toBeUndefined()
    }
  })

  it('an authenticated request is never answered with a public policy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { authorization: `StellarSignature ${ADDR}:sig:nonce` },
    })
    expect(res.headers['cache-control']).toBe(CACHE_POLICIES.private)
  })

  it('cursor pages are public-historical and tip pages public-live', async () => {
    const hist = await app.inject({ method: 'GET', url: '/api/interest?before=100' })
    expect(hist.headers['cache-control']).toBe(CACHE_POLICIES['public-historical'])
    const live = await app.inject({ method: 'GET', url: '/api/interest' })
    expect(live.headers['cache-control']).toBe(CACHE_POLICIES['public-live'])
    expect(live.headers.etag).toBeTruthy()
  })
})

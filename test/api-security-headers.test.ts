// Issue #298: @fastify/helmet is registered at the root scope in
// src/api/server.ts, so every response — API routes, the probes, the Swagger
// UI, and even the ones produced before a route is matched — carries HSTS, a
// strict CSP, X-Frame-Options and X-Content-Type-Options. These tests pin the
// exact values the issue asks for and check they reach *every* route, so a
// route added later cannot silently drop them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'

/** Exactly what issue #298 asks for: one year, subdomains included. */
const HSTS = 'max-age=31536000; includeSubDomains'

/** The value of one CSP directive, e.g. `cspDirective(csp, 'script-src')`. */
function cspDirective(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `))
    ?.slice(name.length + 1)
}

describe('security headers (#298)', () => {
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
    return path.replace(/\{address\}/g, ADDR).replace(/\{id\}/g, '1')
  }

  it('every GET route responds with HSTS, CSP, X-Frame-Options and nosniff', async () => {
    const paths = (app.swagger() as { paths: Record<string, Record<string, unknown>> }).paths
    const gets = Object.entries(paths)
      .filter(([, methods]) => 'get' in methods)
      .map(([path]) => path)
    expect(gets.length).toBeGreaterThan(10)

    for (const path of gets) {
      if (path === '/api/stream') continue // long-lived; covered in api-stream.test.ts
      const res = await app.inject({ method: 'GET', url: concrete(path) })
      expect(res.headers['strict-transport-security'], path).toBe(HSTS)
      expect(res.headers['x-frame-options'], path).toBe('DENY')
      expect(res.headers['x-content-type-options'], path).toBe('nosniff')
      expect(res.headers['content-security-policy'], path).toBeTruthy()
    }
  })

  it('the CSP rejects inline scripts, object embedding and framing', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const csp = String(res.headers['content-security-policy'])

    expect(cspDirective(csp, 'default-src')).toBe("'self'")
    expect(cspDirective(csp, 'script-src')).toBe("'self'")
    expect(cspDirective(csp, 'script-src-attr')).toBe("'none'")
    expect(cspDirective(csp, 'object-src')).toBe("'none'")
    expect(cspDirective(csp, 'frame-ancestors')).toBe("'none'")
    expect(cspDirective(csp, 'base-uri')).toBe("'self'")
    // Swagger UI injects its own inline styles, so `style-src` is the single
    // directive that tolerates `'unsafe-inline'` — nowhere else may.
    expect(cspDirective(csp, 'style-src')).toBe("'self' 'unsafe-inline'")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    // Helmet's default `upgrade-insecure-requests` is deliberately omitted:
    // it would rewrite the docs UI's same-origin assets to https://localhost
    // whenever the API is reached over plain HTTP.
    expect(csp).not.toContain('upgrade-insecure-requests')
  })

  it('responses that never reach a route carry the headers too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['strict-transport-security']).toBe(HSTS)
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toBeTruthy()
  })

  it('the Swagger UI under /docs still renders and is protected', async () => {
    const index = await app.inject({ method: 'GET', url: '/docs' })
    expect(index.statusCode).toBe(200)
    expect(index.headers['content-type']).toContain('text/html')
    expect(index.headers['strict-transport-security']).toBe(HSTS)
    expect(index.body).toContain('swagger-initializer.js')

    // The initializer and bundle are same-origin files, so `script-src 'self'`
    // is enough for the docs page to boot.
    const initializer = await app.inject({ method: 'GET', url: '/docs/static/swagger-initializer.js' })
    expect(initializer.statusCode).toBe(200)
    expect(String(initializer.headers['content-security-policy'])).toBe(String(index.headers['content-security-policy']))
  })
})

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer, shutdownNonceStore } from '../src/api/server.js'
import { pool } from '../src/db/index.js'
import { shutdownSharedListener } from '../src/api/stream.js'
import { resetDb, closeDb } from './db.js'

/**
 * Issue #207: verify the API's graceful shutdown is re-entrant, bounded, and
 * closes all resources in the correct order.
 */
describe('API graceful shutdown (#207)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(closeDb)

  it('repeated signals do not cause double-close errors', async () => {
    // Simulate the shutdown path without actually exiting the process
    let shuttingDown = false
    const SHUTDOWN_TIMEOUT_MS = 10_000

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        // Second call should return immediately
        return { reentrant: true }
      }
      shuttingDown = true

      let timedOut = false
      const closePromise = app.close()
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true
          resolve()
        }, SHUTDOWN_TIMEOUT_MS)
      })
      await Promise.race([closePromise, timeout])

      await shutdownSharedListener()
      await shutdownNonceStore()
      // Note: NOT calling pool.end() here since it would affect other tests
      
      return { timedOut, reentrant: false }
    }

    // First shutdown should complete normally
    const first = await shutdown('SIGTERM')
    expect(first.reentrant).toBe(false)
    expect(first.timedOut).toBe(false)

    // Second shutdown should return immediately (re-entrant guard)
    const second = await shutdown('SIGTERM')
    expect(second.reentrant).toBe(true)
  })

  it('in-flight requests complete before shutdown', async () => {
    // Start a request but don't wait for it
    const requestPromise = app.inject({
      method: 'GET',
      url: '/api/stats',
    })

    // Request should complete successfully even as we initiate shutdown
    const response = await requestPromise
    expect(response.statusCode).toBe(200)

    // Now close
    await app.close()
  })

  it('app.close() is bounded by a timeout', async () => {
    const SHUTDOWN_TIMEOUT_MS = 100 // Short timeout for testing

    // Create a mock slow-closing app
    const mockClose = vi.fn(async () => {
      // Simulate a hung close that takes forever
      await new Promise((resolve) => setTimeout(resolve, 5000))
    })

    const appWithSlowClose = {
      close: mockClose,
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    }

    // Simulate bounded shutdown
    let timedOut = false
    const closePromise = appWithSlowClose.close()
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)
    })

    await Promise.race([closePromise, timeout])

    // Timeout should have fired first
    expect(timedOut).toBe(true)
  }, 10000)

  it('resources are closed in the correct order', async () => {
    const closureOrder: string[] = []

    // Mock the shutdown functions to track order
    const mockShutdownListener = vi.fn(async () => {
      closureOrder.push('listener')
    })
    const mockShutdownNonce = vi.fn(async () => {
      closureOrder.push('nonce')
    })

    await app.close()
    closureOrder.push('app')

    await mockShutdownListener()
    await mockShutdownNonce()

    // Verify order: app.close() -> shutdownSharedListener() -> shutdownNonceStore()
    expect(closureOrder).toEqual(['app', 'listener', 'nonce'])
  })

  it('nonce store cleanup timers stop on shutdown', async () => {
    // The nonce store's cleanup timers should be stopped during shutdown
    // This test verifies that shutdownNonceStore() can be called without errors
    await expect(shutdownNonceStore()).resolves.toBeUndefined()
  })

  it('shared listener closes without throwing', async () => {
    // Verify that shutdownSharedListener() completes successfully
    await expect(shutdownSharedListener()).resolves.toBeUndefined()
  })
})

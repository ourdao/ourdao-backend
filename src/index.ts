import { config } from './config.js'
import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { buildServer } from './api/server.js'
import { initTelemetry } from './telemetry.js'

async function main(): Promise<void> {
  initTelemetry()
  await migrate()
  const app = await buildServer()
  await app.listen({ port: config.http.port, host: config.http.host })

  // Issue #207: guard against re-entrant shutdown — two signals sent rapidly
  // would otherwise invoke shutdown twice concurrently, causing the second
  // pool.end() to throw "Called end on pool more than once".
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      app.log.info(`received ${signal} again while already shutting down, ignoring`)
      return
    }
    shuttingDown = true
    app.log.info(`received ${signal}, shutting down`)

    // Issue #207: bound the wait for app.close() so an in-flight request
    // cannot hang shutdown forever (matches the worker's pattern in
    // src/worker.ts). Race against a timeout; if the timeout wins, log it
    // but continue anyway — the pool and listener still need to close.
    let timedOut = false
    const closePromise = app.close()
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)
    })
    await Promise.race([closePromise, timeout])

    if (timedOut) {
      app.log.error(
        `app.close() timed out after ${SHUTDOWN_TIMEOUT_MS}ms — continuing with pool/listener shutdown anyway`
      )
    }

    // Issue #261: Drain all active SSE stream clients before closing the pool,
    // giving them time to complete any in-flight writes. This prevents
    // "Connection terminated unexpectedly" errors during graceful shutdown.
    await drainStreamClients()

    // Issue #152 / #207: the /api/stream shared listener holds a standalone
    // connection outside `pool`, and every open SSE connection holds a pool
    // connection underneath a live LISTEN — close all of them explicitly
    // before pool.end(), so pool.end() doesn't try to force-close
    // connections that are mid-LISTEN.
    await shutdownSharedListener()
    // Issue #207: shut down the nonce store's cleanup timers before ending
    // the pool, so they don't fire after the pool is closed.
    await shutdownNonceStore()
    await closeRedis()
    await pool.end()
    // Issue #381: flush buffered spans to the collector before exiting.
    await shutdownTelemetry()
    app.log.info('shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[api] failed to start:', err)
  process.exit(1)
})

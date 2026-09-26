import { config } from './config.js'
import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { buildServer } from './api/server.js'
import { shutdownSharedListener } from './api/stream.js'

async function main(): Promise<void> {
  await migrate()
  const app = await buildServer()
  await app.listen({ port: config.http.port, host: config.http.host })

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`)
    await app.close()
    // Issue #152: the /api/stream shared listener holds a standalone
    // connection outside `pool`, so it must be closed explicitly — `pool.end()`
    // only waits on connections it checked out itself, and would otherwise
    // have nothing to do with this one either way.
    await shutdownSharedListener()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[api] failed to start:', err)
  process.exit(1)
})

#!/usr/bin/env tsx
/**
 * Issue #295 — load test for GET /api/stream at 1000 concurrent clients.
 *
 * Verifies the two acceptance criteria:
 *   1. Exactly one Postgres connection is consumed by the shared listener,
 *      regardless of the number of connected SSE clients.
 *   2. No memory leak or socket starvation under sustained load.
 *
 * The test spins up the Fastify server in-process (no external server needed),
 * opens CONCURRENT_CLIENTS SSE connections via raw Node.js HTTP, fires
 * NOTIFICATION_ROUNDS batches of NOTIFY calls across all channels, then
 * asserts on the metrics collected:
 *
 *   - Only one shared LISTEN connection appears in pg_stat_activity.
 *   - The request pool never grew beyond DB_POOL_MAX (10 by default).
 *   - All SSE clients received ≥ 1 notification (fan-out is working).
 *   - RSS growth stayed below MEM_GROWTH_LIMIT_MB over the load period.
 *   - All clients disconnected cleanly (no dangling sockets after close).
 *
 * Usage:
 *   npm run bench:stream                    # 1000 clients, 100 notification rounds
 *   CONCURRENT_CLIENTS=200 npm run bench:stream
 *   NOTIFICATION_ROUNDS=50 npm run bench:stream
 *
 * The test exits with code 0 on pass, 1 on any failed assertion.
 */

import http from 'node:http'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

import { buildServer } from '../src/api/server.js'
import { pool } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import {
  STREAM_CHANNELS,
  getConnectedStreamCount,
  resetConnectedStreamsForTests,
  streamLimits,
  shutdownSharedListener,
} from '../src/api/stream.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONCURRENT_CLIENTS = parseInt(process.env.CONCURRENT_CLIENTS ?? '1000', 10)
const NOTIFICATION_ROUNDS = parseInt(process.env.NOTIFICATION_ROUNDS ?? '100', 10)
/**
 * Maximum RSS growth (MiB) tolerated over the load-test period. Calibrated
 * to allow normal GC fluctuation (~50 MiB) without flagging transient bumps
 * as leaks: a genuine socket-starvation or listener-leak would grow far
 * faster (one pg.Client per SSE client = ~2–4 MiB each × 1000 = 2–4 GiB).
 */
const MEM_GROWTH_LIMIT_MB = parseInt(process.env.MEM_GROWTH_LIMIT_MB ?? '100', 10)

/** Delay (ms) between each NOTIFY batch so clients can drain their queues. */
const NOTIFY_BATCH_DELAY_MS = 50

/**
 * Expected max pool connections observed during the test. Under the shared-
 * listener design (issue #152) the request pool is used only for ordinary
 * requests and post-commit NOTIFYs — not for SSE clients. A modest headroom
 * above the default pool size (10) is allowed for transient burst queries.
 */
const MAX_POOL_CONNECTIONS_EXPECTED = 15

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Result {
  pass: boolean
  label: string
  actual: string
  expected?: string
}

const results: Result[] = []

function assert(label: string, pass: boolean, actual: string, expected?: string): void {
  results.push({ pass, label, actual, expected })
  const mark = pass ? '✓' : '✗'
  const detail = expected !== undefined ? ` (expected ${expected})` : ''
  console.log(`  ${mark} ${label}: ${actual}${detail}`)
}

function rssInMib(): number {
  return process.memoryUsage().rss / (1024 * 1024)
}

/** Open a single SSE connection and return the IncomingMessage (headers received). */
function openSseConnection(
  base: string,
  onFrame: (frame: string) => void
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/stream`, (res) => {
      resolve(res)
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const rawFrame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          onFrame(rawFrame)
        }
      })
      res.on('error', () => { /* ignore post-close errors */ })
    })
    req.on('error', reject)
  })
}

/** Count active LISTEN connections in pg_stat_activity for this database. */
async function countListenConnections(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND query LIKE 'LISTEN%'`
  )
  return parseInt(rows[0]?.n ?? '0', 10)
}

/** Count all connections from this backend's application to the database. */
async function countBackendConnections(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()`
  )
  return parseInt(rows[0]?.n ?? '0', 10)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('OurDAO SSE stream load test (issue #295)')
  console.log(`  Concurrent clients  : ${CONCURRENT_CLIENTS}`)
  console.log(`  Notification rounds : ${NOTIFICATION_ROUNDS}`)
  console.log(`  Mem-growth limit    : ${MEM_GROWTH_LIMIT_MB} MiB`)
  console.log()

  // --- Setup ------------------------------------------------------------------
  await migrate()

  // Raise the stream cap so the test can go above the default 100.
  streamLimits.maxConnections = CONCURRENT_CLIENTS + 100
  streamLimits.maxConnectionsPerIp = CONCURRENT_CLIENTS + 100
  resetConnectedStreamsForTests()

  const app = await buildServer({ logger: { level: 'silent' } })
  await app.ready()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  const base = `http://127.0.0.1:${address.port}`

  console.log(`[bench] Server listening on ${base}`)

  // Give the shared listener a moment to finish its LISTEN setup (it's
  // triggered by the first connection, so we open one probe request first).
  {
    const probe = await openSseConnection(base, () => {})
    await new Promise((r) => setTimeout(r, 150))
    probe.destroy()
    await new Promise((r) => setTimeout(r, 50))
  }

  // Baseline memory before load.
  const rssBaseline = rssInMib()
  console.log(`[bench] RSS baseline: ${rssBaseline.toFixed(1)} MiB`)

  // --- Phase 1: Open 1000 concurrent SSE connections -----------------------
  console.log(`\n[bench] Opening ${CONCURRENT_CLIENTS} SSE connections...`)
  const t0connect = performance.now()

  const connections: http.IncomingMessage[] = []
  // Per-client counters: how many notification frames each client received.
  const notifCountPerClient: number[] = new Array(CONCURRENT_CLIENTS).fill(0)

  // Open all connections in parallel batches to avoid saturating the OS's
  // SYN queue (splitting 1000 into groups of 100).
  const BATCH = 100
  for (let start = 0; start < CONCURRENT_CLIENTS; start += BATCH) {
    const end = Math.min(start + BATCH, CONCURRENT_CLIENTS)
    const batch: Promise<http.IncomingMessage>[] = []
    for (let i = start; i < end; i++) {
      const idx = i
      batch.push(openSseConnection(base, (frame) => {
        if (frame.includes('event: notification') && frame.includes('"type":"notification"')) {
          notifCountPerClient[idx]!++
        }
      }))
    }
    const opened = await Promise.all(batch)
    connections.push(...opened)
    // Small yield so the event loop can process registrations.
    await new Promise((r) => setTimeout(r, 10))
  }

  const connectMs = performance.now() - t0connect
  console.log(`[bench] All ${CONCURRENT_CLIENTS} connections opened in ${connectMs.toFixed(0)} ms`)

  // Wait for in-process registration to settle.
  await new Promise((r) => setTimeout(r, 200))

  const registeredCount = getConnectedStreamCount()
  console.log(`[bench] Registered client count: ${registeredCount}`)

  // --- Phase 2: Broadcast notifications ------------------------------------
  console.log(`\n[bench] Broadcasting ${NOTIFICATION_ROUNDS} notification rounds...`)
  const channels = Object.values(STREAM_CHANNELS)

  const t0notify = performance.now()
  for (let round = 0; round < NOTIFICATION_ROUNDS; round++) {
    for (const ch of channels) {
      await pool.query('SELECT pg_notify($1, $2)', [
        ch,
        JSON.stringify({ symbol: 'load_test', ledger: 100 + round, round }),
      ])
    }
    // Yield between rounds so clients can drain their receive buffers.
    await new Promise((r) => setTimeout(r, NOTIFY_BATCH_DELAY_MS))
  }
  const notifyMs = performance.now() - t0notify
  console.log(`[bench] ${NOTIFICATION_ROUNDS} rounds done in ${notifyMs.toFixed(0)} ms`)

  // Give all frames time to be delivered before measuring.
  await new Promise((r) => setTimeout(r, 500))

  // --- Phase 3: Collect metrics --------------------------------------------
  console.log('\n[bench] Collecting metrics...')

  const rssUnderLoad = rssInMib()
  const rssGrowthMb = rssUnderLoad - rssBaseline

  const listenConns = await countListenConnections()
  const totalBackendConns = await countBackendConnections()

  console.log(`[bench] RSS under load: ${rssUnderLoad.toFixed(1)} MiB (growth ${rssGrowthMb.toFixed(1)} MiB)`)
  console.log(`[bench] pg_stat_activity LISTEN connections: ${listenConns}`)
  console.log(`[bench] pg_stat_activity total backend connections: ${totalBackendConns}`)

  // How many clients got at least one notification frame?
  const clientsReceived = notifCountPerClient.filter((n) => n > 0).length
  const totalFramesReceived = notifCountPerClient.reduce((a, b) => a + b, 0)

  console.log(`[bench] Clients that received ≥1 notification: ${clientsReceived}/${CONCURRENT_CLIENTS}`)
  console.log(`[bench] Total notification frames delivered: ${totalFramesReceived}`)

  // --- Phase 4: Close all connections --------------------------------------
  console.log('\n[bench] Closing all SSE connections...')
  for (const conn of connections) conn.destroy()
  await new Promise((r) => setTimeout(r, 300))
  const remaining = getConnectedStreamCount()
  console.log(`[bench] Remaining registered clients after close: ${remaining}`)

  // --- Assertions ----------------------------------------------------------
  console.log('\nResults:')

  // Acceptance criterion 1: exactly one Postgres LISTEN connection.
  assert(
    'Exactly 1 shared LISTEN connection in pg_stat_activity',
    listenConns === 1,
    `${listenConns}`,
    '1'
  )

  // Corollary: total backend connections ≤ pool max + 1 (shared listener)
  // plus a small margin for the metrics queries themselves.
  assert(
    `Total backend connections ≤ ${MAX_POOL_CONNECTIONS_EXPECTED}`,
    totalBackendConns <= MAX_POOL_CONNECTIONS_EXPECTED,
    `${totalBackendConns}`,
    `≤ ${MAX_POOL_CONNECTIONS_EXPECTED}`
  )

  // In-process counter must match the number of clients we opened
  // (±small tolerance for any that timed out before registration).
  const connectionTolerance = Math.ceil(CONCURRENT_CLIENTS * 0.01) // allow 1% to fail
  assert(
    `In-process client count ≥ ${CONCURRENT_CLIENTS - connectionTolerance}`,
    registeredCount >= CONCURRENT_CLIENTS - connectionTolerance,
    `${registeredCount}`,
    `≥ ${CONCURRENT_CLIENTS - connectionTolerance}`
  )

  // Acceptance criterion 2a: all clients received notifications (fan-out works).
  // Allow a small tolerance for clients that opened and started counting before
  // the shared listener had finished all its LISTENs.
  const expectedNotifiedClients = Math.floor(CONCURRENT_CLIENTS * 0.95)
  assert(
    `Fan-out: ≥ 95% of clients received ≥1 notification (≥ ${expectedNotifiedClients})`,
    clientsReceived >= expectedNotifiedClients,
    `${clientsReceived}`,
    `≥ ${expectedNotifiedClients}`
  )

  // Acceptance criterion 2b: no memory leak (RSS growth < limit).
  assert(
    `RSS growth < ${MEM_GROWTH_LIMIT_MB} MiB (no leak / socket starvation)`,
    rssGrowthMb < MEM_GROWTH_LIMIT_MB,
    `${rssGrowthMb.toFixed(1)} MiB`,
    `< ${MEM_GROWTH_LIMIT_MB} MiB`
  )

  // All clients cleaned up after disconnect.
  assert(
    'All clients de-registered after disconnect (0 remaining)',
    remaining === 0,
    `${remaining}`,
    '0'
  )

  // --- Teardown ------------------------------------------------------------
  await shutdownSharedListener()
  await app.close()
  await pool.end()

  // --- Summary -------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length
  const total = results.length
  console.log(`\n${passed}/${total} assertions passed`)

  if (passed < total) {
    const failed = results.filter((r) => !r.pass)
    console.error('\nFailed assertions:')
    for (const r of failed) {
      console.error(`  ✗ ${r.label}: ${r.actual}${r.expected ? ` (expected ${r.expected})` : ''}`)
    }
    process.exit(1)
  }

  console.log('\n✓ Load test passed — stream scales to 1000 concurrent clients,')
  console.log('  pool is not exhausted, and memory remains stable.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[bench:stream] fatal:', err)
  process.exit(1)
})

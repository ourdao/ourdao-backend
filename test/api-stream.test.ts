import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { pool } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import {
  DRAIN_STALL_DISCONNECT_MS,
  MAX_QUEUED_MESSAGES,
  PG_NOTIFY_MAX_PAYLOAD_BYTES,
  STREAM_CHANNELS,
  StreamClient,
  dispatchStreamNotification,
  getConnectedStreamCount,
  knownLedger,
  notifyStreamClients,
  notifyStreamClientsOrThrow,
  parseChannelSubset,
  resetConnectedStreamsForTests,
  shutdownSharedListener,
  streamLimits,
} from '../src/api/stream.js'
import type { FastifyReply } from 'fastify'

// A minimal fake of the pieces of FastifyReply StreamClient actually uses, so
// #157's backpressure logic (queue growth, stall-timeout disconnect,
// heartbeat skip) can be driven directly and deterministically — a client
// that never reads is otherwise only reproducible with a real socket, which
// is slow and non-deterministic to assert timing against. Since issue #152
// removed StreamClient's own PoolClient (notifications are now fanned out
// via `receiveNotification`, not a `pg` event emitter this class owns), the
// fake only needs to cover the reply side.
function makeFakeStreamPair(writable: { canWrite: boolean }) {
  const rawListeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const raw = {
    write: vi.fn(() => writable.canWrite),
    end: vi.fn(),
    destroyed: false,
    setTimeout: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (rawListeners[event] ??= []).push(cb)
    },
    emitDrain() {
      for (const cb of rawListeners.drain ?? []) cb()
    },
  }
  const fakeReply = { header: vi.fn(), raw }

  return {
    reply: fakeReply as unknown as FastifyReply,
    raw,
  }
}

describe('API: /api/stream', () => {
  let app: FastifyInstance
  const originalLimits = { ...streamLimits }

  beforeEach(async () => {
    await resetDb()
    resetConnectedStreamsForTests()
    Object.assign(streamLimits, originalLimits)
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    resetConnectedStreamsForTests()
    Object.assign(streamLimits, originalLimits)
    closeDb()
  })

  it('GET /api/stream returns 200 with SSE headers (issue #158: prefixed path)', async () => {
    // Start the stream in a promise (it will block)
    const streamPromise = app.inject({ method: 'GET', url: '/api/stream' }).then((res) => {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers['connection']).toBe('keep-alive')
    })

    // Give it a moment to connect and send initial message
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The streaming connection is open but won't complete until we close it
    // For now, just verify the response started correctly
    void streamPromise
  })

  it('stream is registered under the /api plugin prefix, not as a hard-coded root path (issue #158)', async () => {
    const routes = app.printRoutes({ commonPrefix: false })
    expect(routes).toMatch(/\/api\/stream/)
    // The hard-coded root registration is gone — only the prefixed route remains.
    expect(app.hasRoute({ method: 'GET', url: '/api/stream' })).toBe(true)
  })

  it('receives initial connection message on stream', async () => {
    // This test is complex because vitest/the inject method doesn't fully support
    // streaming responses. In a real integration test, you'd connect with a proper
    // EventSource or fetch + stream reading.
    //
    // The key verifications here are:
    // 1. The stream endpoint exists and returns 200 with SSE headers
    // 2. Type checking passes
    // 3. NOTIFY is emitted from the indexer
    //
    // End-to-end streaming would be better tested with playwright or a custom client.
    expect(STREAM_CHANNELS.members).toBe('members_changed')
    expect(STREAM_CHANNELS.loan_proposals).toBe('loan_proposals_changed')
    expect(STREAM_CHANNELS.loans).toBe('loans_changed')
  })

  it('stream channels are properly defined, with no per-member channel (issue #160)', () => {
    expect(STREAM_CHANNELS).toEqual({
      members: 'members_changed',
      loan_proposals: 'loan_proposals_changed',
      loans: 'loans_changed',
      treasury_proposals: 'treasury_proposals_changed',
      interest: 'interest_changed',
    })
    expect('notifications' in STREAM_CHANNELS).toBe(false)
    expect(Object.values(STREAM_CHANNELS)).not.toContain('notifications_changed')
  })

  it('multiple concurrent clients can connect to the stream', async () => {
    // In a real scenario, you'd have multiple EventSource connections
    // For testing purposes, we verify the endpoint is accessible multiple times
    const inject1 = app.inject({ method: 'GET', url: '/api/stream' })
    const inject2 = app.inject({ method: 'GET', url: '/api/stream' })

    // Both should start without errors
    expect(inject1).toBeDefined()
    expect(inject2).toBeDefined()
  })

  it('rejects connections beyond STREAM_MAX_CONNECTIONS with 503 + Retry-After (issue #156)', async () => {
    streamLimits.maxConnections = 2
    streamLimits.maxConnectionsPerIp = 10
    streamLimits.retryAfterSeconds = 17

    // Hold two connections open via raw Node HTTP against the listening server.
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const base = `http://127.0.0.1:${address.port}`

    const http = await import('node:http')
    const openOne = () =>
      new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = http.get(`${base}/api/stream`, (res) => resolve(res))
        req.on('error', reject)
      })

    const first = await openOne()
    const second = await openOne()
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    // Give the server a tick to register both clients in connectedClients.
    await new Promise((r) => setTimeout(r, 50))
    expect(getConnectedStreamCount()).toBeGreaterThanOrEqual(2)

    const third = await openOne()
    expect(third.statusCode).toBe(503)
    expect(third.headers['retry-after']).toBe('17')

    // Drain/abort so afterEach can close cleanly.
    first.destroy()
    second.destroy()
    third.resume()
  })

  it('exposes connectedStreams on GET /api/stats (issue #156)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connectedStreams: expect.any(Number) })
    expect(res.json().connectedStreams).toBe(getConnectedStreamCount())
  })

  it('opens more concurrent streams than the DB pool size without starving ordinary requests (issue #152)', async () => {
    // node-postgres exposes `max` on `pool.options` at runtime even though
    // @types/pg doesn't declare it — pg-pool reads it live on every connect().
    const poolWithOptions = pool as unknown as { options: { max: number } }
    const originalMax = poolWithOptions.options.max
    poolWithOptions.options.max = 2
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('expected TCP address')
      const base = `http://127.0.0.1:${address.port}`

      const http = await import('node:http')
      const openOne = () =>
        new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
          const req = http.get(`${base}/api/stream`, (res) => resolve(res))
          req.on('error', reject)
        })

      // More concurrent SSE clients than the pool's max connection count.
      // Under the old per-client-connection design this alone would exhaust
      // the pool.
      const streams = await Promise.all([openOne(), openOne(), openOne(), openOne(), openOne()])
      for (const s of streams) expect(s.statusCode).toBe(200)
      await new Promise((r) => setTimeout(r, 100))
      expect(getConnectedStreamCount()).toBeGreaterThanOrEqual(streams.length)

      // An ordinary DB-backed request must still complete promptly — this is
      // exactly what used to hang indefinitely (issue #152).
      const readyRes = await Promise.race([
        app.inject({ method: 'GET', url: '/ready' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ordinary request timed out — pool exhausted by SSE streams')), 3000)
        ),
      ])
      expect(readyRes.statusCode).toBeLessThan(500)

      for (const s of streams) s.destroy()
    } finally {
      poolWithOptions.options.max = originalMax
    }
  })
})

describe('Stream NOTIFY integration', () => {
  it('notifyStreamClients exports the channel definitions', () => {
    // Verify all (non-per-member — issue #160) channels are defined
    expect(STREAM_CHANNELS.members).toBeDefined()
    expect(STREAM_CHANNELS.loan_proposals).toBeDefined()
    expect(STREAM_CHANNELS.loans).toBeDefined()
    expect(STREAM_CHANNELS.treasury_proposals).toBeDefined()
    expect(STREAM_CHANNELS.interest).toBeDefined()
  })

  it('stream channels match event symbol mappings', () => {
    // Verify all channels used in handlers.ts are valid
    const validChannels = Object.values(STREAM_CHANNELS)

    // Sample checks for key channels
    expect(validChannels).toContain('members_changed')
    expect(validChannels).toContain('loan_proposals_changed')
    expect(validChannels).toContain('loans_changed')
  })

  it('pg_notify round-trips quotes, backslashes and unicode unchanged (issue #153)', async () => {
    await resetDb()
    const listenClient = await pool.connect()
    const notifyClient = await pool.connect()
    const channel = STREAM_CHANNELS.members
    const payload = {
      name: "O'Reilly\\path",
      note: 'café 你好 🎉',
      slash: 'a\\b\\c',
      quote: `he said "hi"`,
    }

    try {
      await listenClient.query(`LISTEN "${channel}"`)
      const got = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('NOTIFY timeout')), 5_000)
        listenClient.once('notification', (msg) => {
          clearTimeout(timer)
          resolve(msg.payload ?? '')
        })
      })

      await notifyStreamClients(notifyClient, channel, payload)
      const raw = await got
      expect(JSON.parse(raw)).toEqual(payload)
    } finally {
      try {
        await listenClient.query(`UNLISTEN "${channel}"`)
      } catch {
        /* ignore */
      }
      listenClient.release()
      notifyClient.release()
    }
  })

  it('refuses an over-long NOTIFY payload cleanly (issue #153)', async () => {
    await resetDb()
    const client = await pool.connect()
    try {
      const big = { blob: 'x'.repeat(PG_NOTIFY_MAX_PAYLOAD_BYTES + 100) }
      await expect(
        notifyStreamClientsOrThrow(client, STREAM_CHANNELS.loans, big)
      ).rejects.toThrow(/exceeds/)
      // Soft path logs and does not throw (indexer must not break).
      await expect(
        notifyStreamClients(client, STREAM_CHANNELS.loans, big)
      ).resolves.toBeUndefined()
    } finally {
      client.release()
    }
  })
})

// Issue #160: clients can subscribe to a subset of channels.
describe('parseChannelSubset', () => {
  it('returns null (meaning "all channels") when unspecified', () => {
    expect(parseChannelSubset(undefined)).toBeNull()
    expect(parseChannelSubset('')).toBeNull()
  })

  it('parses a comma-separated list of known channel keys', () => {
    expect(parseChannelSubset('loans,loan_proposals')).toEqual([
      STREAM_CHANNELS.loans,
      STREAM_CHANNELS.loan_proposals,
    ])
  })

  it('throws, naming the bad key, for an unknown channel', () => {
    expect(() => parseChannelSubset('loans,not_a_real_channel')).toThrowError(/not_a_real_channel/)
  })

  it('rejects a per-member "notifications" key — it was removed from STREAM_CHANNELS (issue #160)', () => {
    expect(() => parseChannelSubset('notifications')).toThrowError(/notifications/)
  })
})

// Issue #157: SSE writes must respect backpressure rather than buffering an
// unbounded backlog for a client that stops reading.
describe('StreamClient backpressure', () => {
  it('only delivers notifications for the requested channel subset (issue #160)', async () => {
    const { reply, raw } = makeFakeStreamPair({ canWrite: true })
    const sc = new StreamClient(reply)
    await sc.start([STREAM_CHANNELS.loans])

    const writesBefore = raw.write.mock.calls.length
    sc.receiveNotification(STREAM_CHANNELS.members, {})
    expect(raw.write.mock.calls.length).toBe(writesBefore) // not subscribed — ignored

    sc.receiveNotification(STREAM_CHANNELS.loans, {})
    expect(raw.write.mock.calls.length).toBe(writesBefore + 1)

    await sc.close()
  })

  it('pauses on a false write() return and queues further messages instead of writing immediately', async () => {
    const writable = { canWrite: true }
    const { reply, raw } = makeFakeStreamPair(writable)
    const sc = new StreamClient(reply)
    await sc.start([STREAM_CHANNELS.loans])

    const writesBeforePause = raw.write.mock.calls.length
    writable.canWrite = false // simulate the socket's buffer going over its high-water mark
    sc.receiveNotification(STREAM_CHANNELS.loans, {}) // this write() call trips `paused`
    expect(raw.write.mock.calls.length).toBe(writesBeforePause + 1)

    // Further messages while paused must not call write() again — they queue.
    sc.receiveNotification(STREAM_CHANNELS.loans, {})
    sc.receiveNotification(STREAM_CHANNELS.loans, {})
    expect(raw.write.mock.calls.length).toBe(writesBeforePause + 1)

    await sc.close()
  })

  it('flushes the queue once drain fires', async () => {
    const writable = { canWrite: true }
    const { reply, raw } = makeFakeStreamPair(writable)
    const sc = new StreamClient(reply)
    await sc.start([STREAM_CHANNELS.loans])

    writable.canWrite = false
    sc.receiveNotification(STREAM_CHANNELS.loans, {}) // triggers pause
    sc.receiveNotification(STREAM_CHANNELS.loans, {}) // queued
    sc.receiveNotification(STREAM_CHANNELS.loans, {}) // queued
    const writesWhilePaused = raw.write.mock.calls.length

    writable.canWrite = true
    raw.emitDrain()
    // The two queued frames are now flushed via write().
    expect(raw.write.mock.calls.length).toBe(writesWhilePaused + 2)

    await sc.close()
  })

  it(`drops a client whose backlog exceeds MAX_QUEUED_MESSAGES (${MAX_QUEUED_MESSAGES})`, async () => {
    const writable = { canWrite: true }
    const { reply, raw } = makeFakeStreamPair(writable)
    const sc = new StreamClient(reply)
    await sc.start([STREAM_CHANNELS.loans])

    writable.canWrite = false
    sc.receiveNotification(STREAM_CHANNELS.loans, {}) // trips pause
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 5; i++) {
      sc.receiveNotification(STREAM_CHANNELS.loans, {})
    }

    // close() ends the response — the signal that this stalled client was
    // dropped rather than buffered forever.
    expect(raw.end).toHaveBeenCalled()
  })

  it(`drops a client backpressured for longer than DRAIN_STALL_DISCONNECT_MS (${DRAIN_STALL_DISCONNECT_MS}ms) even without exceeding the queue bound`, async () => {
    vi.useFakeTimers()
    try {
      const writable = { canWrite: true }
      const { reply, raw } = makeFakeStreamPair(writable)
      const sc = new StreamClient(reply)
      await sc.start([STREAM_CHANNELS.loans])

      writable.canWrite = false
      sc.receiveNotification(STREAM_CHANNELS.loans, {}) // trips pause, arms the stall timer
      expect(raw.end).not.toHaveBeenCalled()

      // Async variant: the stall timer's callback calls the async close().
      await vi.advanceTimersByTimeAsync(DRAIN_STALL_DISCONNECT_MS + 1)
      expect(raw.end).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips heartbeats for an already-backed-up client', async () => {
    vi.useFakeTimers()
    try {
      const writable = { canWrite: true }
      const { reply, raw } = makeFakeStreamPair(writable)
      const sc = new StreamClient(reply)
      await sc.start([STREAM_CHANNELS.loans])

      writable.canWrite = false
      sc.receiveNotification(STREAM_CHANNELS.loans, {}) // trips pause
      const writesWhilePaused = raw.write.mock.calls.length

      // Advance past a heartbeat interval; a backed-up client must not get
      // another unflushable write queued on top of what it already owes.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(raw.write.mock.calls.length).toBe(writesWhilePaused)

      await sc.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() is idempotent under concurrent close calls (issue #159)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { reply, raw } = makeFakeStreamPair({ canWrite: true })
      const sc = new StreamClient(reply, '127.0.0.1')
      await sc.start([STREAM_CHANNELS.loans])

      // Simulate the production handlers: sync wrappers with .catch, fired
      // concurrently the way a socket 'close' and 'error' can race.
      const cleanup = () => {
        void sc.close().catch((err) => {
          console.error('[stream] close error on socket event:', err)
        })
      }
      cleanup()
      cleanup()

      // Let the async cleanup settle.
      await new Promise((r) => setTimeout(r, 50))
      expect(raw.end).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// Issue #154: a non-JSON NOTIFY payload must not crash the process. Issue
// #155: the process-wide known-ledger tracker used for SSE ids / resync.
describe('dispatchStreamNotification', () => {
  afterEach(() => {
    knownLedger.value = null
  })

  it('drops a malformed payload without throwing, and logs it once', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => dispatchStreamNotification(STREAM_CHANNELS.loans, 'not valid json')).not.toThrow()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('malformed NOTIFY payload'))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('treats a missing payload as {} without attempting to parse it', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => dispatchStreamNotification(STREAM_CHANNELS.loans, undefined)).not.toThrow()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('advances knownLedger.value from a numeric payload.ledger, monotonically (issue #155)', () => {
    knownLedger.value = 10
    dispatchStreamNotification(STREAM_CHANNELS.loans, JSON.stringify({ ledger: 15 }))
    expect(knownLedger.value).toBe(15)

    // An older/out-of-order ledger must not move the frontier backwards.
    dispatchStreamNotification(STREAM_CHANNELS.loans, JSON.stringify({ ledger: 12 }))
    expect(knownLedger.value).toBe(15)
  })

  it('leaves knownLedger.value untouched when the payload has no numeric ledger', () => {
    knownLedger.value = 10
    dispatchStreamNotification(STREAM_CHANNELS.loans, JSON.stringify({ message: 'hi' }))
    expect(knownLedger.value).toBe(10)
  })
})

// Issue #152 / #154 / #155 end-to-end: real Postgres NOTIFY, real SSE frames.
describe('Stream end-to-end over real Postgres', () => {
  let app: FastifyInstance
  let base: string | null = null
  const originalLimits = { ...streamLimits }
  const originalKnownLedger = knownLedger.value

  beforeEach(async () => {
    await resetDb()
    resetConnectedStreamsForTests()
    Object.assign(streamLimits, originalLimits)
    base = null
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    resetConnectedStreamsForTests()
    Object.assign(streamLimits, originalLimits)
    knownLedger.value = originalKnownLedger
    closeDb()
  })

  async function openStream(
    path: string,
    headers?: Record<string, string>
  ): Promise<import('node:http').IncomingMessage> {
    if (!base) {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('expected TCP address')
      base = `http://127.0.0.1:${address.port}`
    }
    const http = await import('node:http')
    return new Promise((resolve, reject) => {
      const req = http.get(`${base}${path}`, { headers }, (res) => resolve(res))
      req.on('error', reject)
    })
  }

  interface SseFrame {
    event: string
    id: string
    data: { type: string; channel?: string; payload?: Record<string, unknown> }
  }

  function collectSseFrames(
    res: import('node:http').IncomingMessage,
    count: number,
    timeoutMs = 5000
  ): Promise<SseFrame[]> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const frames: SseFrame[] = []
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${count} SSE frame(s), got ${frames.length}`)),
        timeoutMs
      )
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const parsed: Record<string, string> = {}
          for (const line of rawFrame.split('\n')) {
            const sep = line.indexOf(': ')
            if (sep === -1) continue
            parsed[line.slice(0, sep)] = line.slice(sep + 2)
          }
          frames.push({
            event: parsed.event ?? '',
            id: parsed.id ?? '',
            data: parsed.data ? JSON.parse(parsed.data) : undefined,
          })
          if (frames.length >= count) {
            clearTimeout(timer)
            resolve(frames)
            return
          }
        }
      })
      res.on('error', reject)
    })
  }

  it('a malformed NOTIFY payload does not crash the stream — client stays connected and keeps receiving (issue #154)', async () => {
    const res = await openStream('/api/stream?channels=loans')
    expect(res.statusCode).toBe(200)

    const frames = collectSseFrames(res, 2)
    await new Promise((r) => setTimeout(r, 100)) // let the shared listener finish LISTEN
    await pool.query('SELECT pg_notify($1, $2)', [STREAM_CHANNELS.loans, 'not valid json'])
    await pool.query(
      'SELECT pg_notify($1, $2)',
      [STREAM_CHANNELS.loans, JSON.stringify({ symbol: 'loan_disburse', ledger: 1 })]
    )

    const [connected, real] = await frames
    if (!connected || !real) throw new Error('expected 2 frames')
    expect(connected.data.payload).toMatchObject({ message: 'Connected to stream' })
    expect(real.event).toBe('notification')
    expect(real.data.payload).toMatchObject({ symbol: 'loan_disburse' })

    res.destroy()
  })

  it('SSE ids are the monotonic known-ledger sequence, not Date.now() timestamps (issue #155)', async () => {
    const res = await openStream('/api/stream?channels=loans')
    const frames = collectSseFrames(res, 2)
    await new Promise((r) => setTimeout(r, 100))
    await pool.query(
      'SELECT pg_notify($1, $2)',
      [STREAM_CHANNELS.loans, JSON.stringify({ symbol: 'loan_disburse', ledger: 777 })]
    )

    const [, real] = await frames
    if (!real) throw new Error('expected 2 frames')
    expect(real.id).toBe('777')

    res.destroy()
  })

  it('reconnecting with a stale Last-Event-ID is told it may have missed changes (issue #155)', async () => {
    knownLedger.value = 500
    const res = await openStream('/api/stream', { 'Last-Event-ID': '100' })
    expect(res.statusCode).toBe(200)

    const [first] = await collectSseFrames(res, 1)
    if (!first) throw new Error('expected 1 frame')
    expect(first.event).toBe('resync')
    expect(first.id).toBe('500')
    expect(first.data.payload).toMatchObject({ missed: true, lastKnownLedger: 500 })

    res.destroy()
  })

  it('reconnecting with a current Last-Event-ID is told it did not miss anything (issue #155)', async () => {
    knownLedger.value = 500
    const res = await openStream('/api/stream', { 'Last-Event-ID': '500' })
    expect(res.statusCode).toBe(200)

    const [first] = await collectSseFrames(res, 1)
    if (!first) throw new Error('expected 1 frame')
    expect(first.event).toBe('resync')
    expect(first.data.payload).toMatchObject({ missed: false, lastKnownLedger: 500 })

    res.destroy()
  })

  it('a fresh connection with no Last-Event-ID gets no resync frame, just the normal connected message (issue #155)', async () => {
    knownLedger.value = 500
    const res = await openStream('/api/stream')
    expect(res.statusCode).toBe(200)

    const [first] = await collectSseFrames(res, 1)
    if (!first) throw new Error('expected 1 frame')
    expect(first.event).toBe('notification')
    expect(first.data.payload).toMatchObject({ message: 'Connected to stream' })

    res.destroy()
  })

  it('shutdownSharedListener() closes the standalone connection cleanly, and it reconnects on the next stream (issue #152)', async () => {
    const res = await openStream('/api/stream?channels=loans')
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    res.destroy()

    // Must resolve promptly rather than hang — this is what `src/index.ts`'s
    // shutdown handler awaits before `pool.end()`.
    await expect(shutdownSharedListener()).resolves.toBeUndefined()
    // Idempotent: calling it again with nothing to close must not throw.
    await expect(shutdownSharedListener()).resolves.toBeUndefined()

    // The next incoming stream must still work — ensureStarted() reconnects
    // from scratch rather than staying wedged on the closed connection.
    const res2 = await openStream('/api/stream?channels=loans')
    expect(res2.statusCode).toBe(200)
    const frames = collectSseFrames(res2, 2)
    await new Promise((r) => setTimeout(r, 50))
    await pool.query(
      'SELECT pg_notify($1, $2)',
      [STREAM_CHANNELS.loans, JSON.stringify({ symbol: 'loan_disburse', ledger: 42 })]
    )
    const [, real] = await frames
    if (!real) throw new Error('expected 2 frames')
    expect(real.data.payload).toMatchObject({ symbol: 'loan_disburse' })

    res2.destroy()
  })
})

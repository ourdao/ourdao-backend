import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import { config } from '../config.js'
import { pool } from '../db/index.js'

/**
 * Server-Sent Events stream for real-time updates (issue #63).
 *
 * Clients connect to GET /api/stream and receive change notifications as events are
 * folded by the indexer. The stream uses Postgres LISTEN/NOTIFY to coordinate
 * between the indexer and connected clients.
 *
 * The stream sends lightweight change signals like "loan_proposals changed" rather
 * than full payloads — clients refetch what they need via existing endpoints.
 *
 * Multiple API instances each LISTEN independently and fan out to their own clients,
 * which is correct without coordination.
 */

export interface StreamMessage {
  type: 'heartbeat' | 'notification' | 'error'
  channel?: string
  payload?: Record<string, unknown>
  timestamp: number
}

/**
 * Event channels for notifications (issue #63).
 * Sent by the indexer via NOTIFY when state changes.
 *
 * Issue #160: this deliberately does NOT include a `notifications_changed`
 * channel. `/api/stream` is unauthenticated and broadcasts to every
 * connected client; the five channels below describe DAO-wide state (fine
 * to broadcast to anyone), but per-member data belongs only on the
 * authenticated GET /api/notifications, which is exactly why that endpoint
 * requires authentication in the first place. A prior version of this file
 * did LISTEN on a `notifications_changed` channel, but nothing anywhere in
 * this codebase ever NOTIFYs it — it was dead wiring, not a live leak — but
 * leaving it in place was a trap: adding a real per-member NOTIFY later
 * would have silently broadcast it to anyone, unauthenticated, with no
 * additional review forcing the question. Clients poll their own feed via
 * GET /api/notifications instead. See README's Security Notes section for
 * the stream's full privacy properties.
 */
export const STREAM_CHANNELS = {
  members: 'members_changed',
  loan_proposals: 'loan_proposals_changed',
  loans: 'loans_changed',
  treasury_proposals: 'treasury_proposals_changed',
  interest: 'interest_changed',
} as const

export type StreamChannel = typeof STREAM_CHANNELS[keyof typeof STREAM_CHANNELS]

// Issue #157: bound what is queued per client rather than letting a stalled
// reader's backlog grow without limit. A client further behind than this
// many messages is dropped — a consumer that can't keep up is better cut
// off than buffered forever. Exported so tests can drive exactly this many
// messages rather than hardcoding a duplicate magic number.
export const MAX_QUEUED_MESSAGES = 200

// Issue #157: if a write has been backpressured (paused, awaiting 'drain')
// for longer than this with no progress, the client is dropped even if its
// queue hasn't hit MAX_QUEUED_MESSAGES yet — e.g. a socket that receives
// only occasional low-volume notifications could otherwise sit paused
// indefinitely, holding its dedicated LISTEN/NOTIFY Postgres connection
// forever without ever growing its queue enough to trip that bound.
export const DRAIN_STALL_DISCONNECT_MS = 30_000

// Issue #157 / #156: transport-level backstop. A healthy connection always
// has outbound traffic at least every 30s (the heartbeat), so this never
// fires for one; a genuinely stalled socket (suspended mobile browser, slept
// laptop, dead link) is eventually closed by Node itself even if nothing
// above ever notices. Overridable via STREAM_IDLE_TIMEOUT_MS.
export const SOCKET_IDLE_TIMEOUT_MS = 60_000

/** Postgres NOTIFY payload hard limit (bytes). Issue #153. */
export const PG_NOTIFY_MAX_PAYLOAD_BYTES = 8000

/**
 * Issue #156: runtime-tunable stream connection bounds. Seeded from config
 * at module load; tests may mutate these to drive over-cap behaviour without
 * re-importing config.
 */
export const streamLimits = {
  maxConnections: config.http.streamMaxConnections,
  maxConnectionsPerIp: config.http.streamMaxConnectionsPerIp,
  idleTimeoutMs: config.http.streamIdleTimeoutMs,
  retryAfterSeconds: config.http.streamRetryAfterSeconds,
}

// Issue #156: module-level tracking so /api/stats (and operators) can observe
// the live count. Each StreamClient removes itself on close.
const connectedClients = new Set<StreamClient>()
const connectionsByIp = new Map<string, number>()

/** Current number of open SSE stream clients on this process (issue #156). */
export function getConnectedStreamCount(): number {
  return connectedClients.size
}

/** Test helper: drop all tracked clients without waiting on sockets. */
export function resetConnectedStreamsForTests(): void {
  connectedClients.clear()
  connectionsByIp.clear()
}

/**
 * Manage a single SSE client connection.
 * Handles LISTEN subscriptions and sends events as they arrive.
 */
export class StreamClient {
  private reply: FastifyReply
  private client: PoolClient
  private channels: Set<StreamChannel> = new Set()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private closed = false
  // Issue #159: guard release() so concurrent close()/error paths cannot
  // double-release the pool client (node-postgres treats that as an error).
  private released = false
  private releasePromise: Promise<void> | null = null
  // Issue #157: `false` from reply.raw.write() means the stream's internal
  // buffer is above its high-water mark — the caller (us) is supposed to
  // stop writing until 'drain'. `paused` tracks that; frames sent while
  // paused go to `queue` instead of straight to the socket.
  private paused = false
  private queue: string[] = []
  private stallTimer: NodeJS.Timeout | null = null
  readonly ip: string

  constructor(reply: FastifyReply, client: PoolClient, ip = 'unknown') {
    this.reply = reply
    this.client = client
    this.ip = ip
  }

  /**
   * Set up the SSE response headers and begin listening for notifications.
   *
   * `channels` lets a client subscribe to a subset (issue #160's query
   * parameter) — defaults to every broadcast channel, matching the
   * previous unconditional-subscribe behavior for a client that doesn't ask.
   */
  async start(channels: readonly StreamChannel[] = Object.values(STREAM_CHANNELS)): Promise<void> {
    this.reply.header('Content-Type', 'text/event-stream')
    this.reply.header('Cache-Control', 'no-cache')
    this.reply.header('Connection', 'keep-alive')
    this.reply.header('X-Accel-Buffering', 'no') // Disable nginx buffering

    // Issue #157 / #156: idle timeout — closed automatically by Node if the
    // socket sits idle (no reads or writes) this long. Heartbeats every 30s
    // keep a healthy connection alive; a client that never receives anything
    // (dead link, slept laptop) is dropped so it cannot hold a pool client.
    const idleMs = streamLimits.idleTimeoutMs
    this.reply.raw.setTimeout(idleMs, () => {
      void this.close().catch((err) => {
        console.error('[stream] close error after socket idle timeout:', err)
      })
    })

    // Issue #157: resume writing once the stream's buffer has drained below
    // its low-water mark.
    this.reply.raw.on('drain', () => {
      this.paused = false
      this.clearStallTimer()
      this.flushQueue()
    })

    // Subscribe to the requested channels (all of them, if unspecified).
    // Channel names come from the frozen STREAM_CHANNELS constant (issue #153
    // out-of-scope for LISTEN; still a frozen identifier, not user input).
    for (const channel of channels) {
      await this.client.query(`LISTEN "${channel}"`)
      this.channels.add(channel)
    }

    // Send an initial message
    this.sendMessage({
      type: 'notification',
      payload: { message: 'Connected to stream' },
      timestamp: Date.now(),
    })

    // Start heartbeat to keep connection alive (every 30 seconds)
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return
      // Issue #157: skip heartbeats for a client that's already backed up —
      // adding more unflushable writes to a stalled socket only makes the
      // eventual queue overflow arrive sooner for no benefit.
      if (this.paused) return
      this.sendMessage({
        type: 'heartbeat',
        timestamp: Date.now(),
      })
    }, 30_000)
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref()
    }

    // Attach listeners to the client
    this.client.on('notification', (msg) => {
      if (!this.closed) {
        this.sendMessage({
          type: 'notification',
          channel: msg.channel,
          payload: msg.payload ? JSON.parse(msg.payload) : {},
          timestamp: Date.now(),
        })
      }
    })

    // Handle client errors
    this.client.on('error', (err) => {
      if (!this.closed) {
        console.error('[stream] client error:', err)
        this.sendMessage({
          type: 'error',
          payload: { error: 'Stream error' },
          timestamp: Date.now(),
        })
        void this.close().catch((closeErr) => {
          console.error('[stream] close error after client error:', closeErr)
        })
      }
    })
  }

  /**
   * Send a message to the client via SSE, respecting backpressure (issue #157).
   */
  private sendMessage(msg: StreamMessage): void {
    if (this.closed) return

    const eventType = msg.type
    const id = `${msg.timestamp}`
    const data = JSON.stringify({
      type: msg.type,
      channel: msg.channel,
      payload: msg.payload,
      timestamp: msg.timestamp,
    })
    // SSE format: event type, id, and data, as a single write so exactly
    // one write() return value governs this whole frame's backpressure.
    const frame = `event: ${eventType}\nid: ${id}\ndata: ${data}\n\n`

    if (this.paused) {
      this.enqueue(frame)
      return
    }
    this.writeFrame(frame)
  }

  private writeFrame(frame: string): void {
    try {
      const ok = this.reply.raw.write(frame)
      if (!ok) {
        this.paused = true
        this.armStallTimer()
      }
    } catch {
      // Ignore write errors (client disconnected)
      if (this.reply.raw.destroyed) {
        this.closed = true
      }
    }
  }

  private enqueue(frame: string): void {
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      // Already over the bound: a consumer that cannot keep up is better
      // dropped than buffered forever (issue #157).
      void this.close().catch((err) => {
        console.error('[stream] close error after queue overflow:', err)
      })
      return
    }
    this.queue.push(frame)
  }

  private flushQueue(): void {
    while (!this.paused && !this.closed && this.queue.length > 0) {
      const frame = this.queue.shift()
      if (frame !== undefined) this.writeFrame(frame)
    }
  }

  private armStallTimer(): void {
    if (this.stallTimer) return
    this.stallTimer = setTimeout(() => {
      // Backpressured for too long with no drain: a stalled reader is
      // better dropped than buffered forever (issue #157).
      void this.close().catch((err) => {
        console.error('[stream] close error after drain stall:', err)
      })
    }, DRAIN_STALL_DISCONNECT_MS)
    if (this.stallTimer.unref) this.stallTimer.unref()
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  /**
   * Clean up resources and close the connection.
   * Idempotent and safe under concurrent invocation (issue #159).
   */
  async close(): Promise<void> {
    if (this.releasePromise) return this.releasePromise
    if (this.closed && this.released) return
    this.closed = true
    this.queue = []
    this.clearStallTimer()

    this.releasePromise = this.doClose()
    return this.releasePromise
  }

  private async doClose(): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // Unlisten from all channels
    for (const channel of this.channels) {
      try {
        await this.client.query(`UNLISTEN "${channel}"`)
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.channels.clear()

    // Release the pool client exactly once (issue #159).
    if (!this.released) {
      this.released = true
      try {
        this.client.release()
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Drop from the process-wide trackers (issue #156).
    if (connectedClients.delete(this)) {
      const n = connectionsByIp.get(this.ip) ?? 0
      if (n <= 1) connectionsByIp.delete(this.ip)
      else connectionsByIp.set(this.ip, n - 1)
    }

    // End the response
    try {
      this.reply.raw.end()
    } catch {
      // Already ended
    }
  }
}

/**
 * Register the stream endpoint under the `/api` plugin prefix (issue #158).
 * Path is `/stream` so the inherited prefix yields `/api/stream`.
 *
 * Rate-limit decision (issue #158): the initial handshake stays under the
 * global `@fastify/rate-limit` (connection *attempts* are requests). Open
 * connections are bounded separately by STREAM_MAX_CONNECTIONS /
 * STREAM_MAX_CONNECTIONS_PER_IP (issue #156) — the request limiter does not
 * model long-lived sockets, so caps are the real resource bound. The route
 * is deliberately NOT added to the allowList.
 *
 * Uses the shared `pool` from `src/db/index.js` like every other route
 * (issue #158) rather than taking an injected Pool.
 */
export function parseChannelSubset(v: unknown): StreamChannel[] | null {
  if (v === undefined || v === null || v === '') return null
  const raw = typeof v === 'string' ? v : String(v)
  const keys = raw.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
  if (keys.length === 0) return null

  const known = STREAM_CHANNELS as Record<string, StreamChannel>
  const unknownKeys = keys.filter((k) => !(k in known))
  if (unknownKeys.length > 0) {
    throw new Error(`unknown channel(s): ${unknownKeys.join(', ')}`)
  }
  return keys.map((k) => known[k]!)
}

export async function registerStreamEndpoint(app: FastifyInstance): Promise<void> {
  // Issue #158: path is relative to the `/api` plugin prefix — no hard-coded `/api`.
  app.get('/stream', async (request, reply) => {
    let channels: StreamChannel[] | null
    try {
      const q = request.query as Record<string, unknown>
      channels = parseChannelSubset(q.channels)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }

    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown'

    // Issue #156: reject before acquiring a pool client when over cap.
    if (connectedClients.size >= streamLimits.maxConnections) {
      reply.header('Retry-After', String(streamLimits.retryAfterSeconds))
      return reply.code(503).send({
        error: 'Too many concurrent stream connections',
        connectedStreams: connectedClients.size,
        maxConnections: streamLimits.maxConnections,
      })
    }
    const ipCount = connectionsByIp.get(ip) ?? 0
    if (ipCount >= streamLimits.maxConnectionsPerIp) {
      reply.header('Retry-After', String(streamLimits.retryAfterSeconds))
      return reply.code(503).send({
        error: 'Too many concurrent stream connections from this address',
        connectedStreams: connectedClients.size,
        maxConnectionsPerIp: streamLimits.maxConnectionsPerIp,
      })
    }

    let streamClient: StreamClient | null = null

    try {
      // Dedicated connection for LISTEN/NOTIFY; StreamClient owns its release.
      const client = await pool.connect()
      streamClient = new StreamClient(reply, client, ip)
      connectedClients.add(streamClient)
      connectionsByIp.set(ip, ipCount + 1)

      // Issue #159: register handlers only after streamClient is assigned, as
      // synchronous wrappers that attach .catch() — EventEmitter ignores the
      // returned promise from an async listener, which would otherwise become
      // an unhandled rejection if close() fails.
      const sc = streamClient
      const onSocketDone = () => {
        void sc.close().catch((err) => {
          console.error('[stream] close error on socket event:', err)
        })
      }
      reply.raw.on('close', onSocketDone)
      reply.raw.on('error', onSocketDone)

      // Start the stream
      await streamClient.start(channels ?? undefined)
    } catch (err) {
      if (streamClient) {
        await streamClient.close().catch((closeErr) => {
          console.error('[stream] close error after setup failure:', closeErr)
        })
      }
      console.error('[stream] error setting up client:', err)
      return reply.code(500).send({ error: 'Failed to establish stream' })
    }
  })
}

/**
 * Emit a NOTIFY to all listening clients (called from the indexer after a transaction commits).
 * This is non-blocking and safe to call from within a transaction — the NOTIFY will be
 * sent when the transaction commits.
 *
 * Issue #153: uses `pg_notify($1, $2)` with bound parameters — no string
 * concatenation / hand-rolled escaping. Payloads over 8000 bytes are refused.
 */
export async function notifyStreamClients(
  client: PoolClient,
  channel: StreamChannel,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const payloadJson = payload ? JSON.stringify(payload) : ''
    const byteLength = Buffer.byteLength(payloadJson, 'utf8')
    if (byteLength > PG_NOTIFY_MAX_PAYLOAD_BYTES) {
      console.error(
        `[stream] NOTIFY payload exceeds ${PG_NOTIFY_MAX_PAYLOAD_BYTES} bytes (${byteLength}); refusing`
      )
      return
    }
    await client.query('SELECT pg_notify($1, $2)', [channel, payloadJson])
  } catch (err) {
    // Log but don't throw — notification failure shouldn't break the indexer
    console.error('[stream] NOTIFY error:', err)
  }
}

/**
 * Like notifyStreamClients, but throws on over-long payloads so callers/tests
 * can assert a clean failure (issue #153). The indexer path keeps the soft
 * refuse-and-log behaviour above.
 */
export async function notifyStreamClientsOrThrow(
  client: PoolClient,
  channel: StreamChannel,
  payload?: Record<string, unknown>
): Promise<void> {
  const payloadJson = payload ? JSON.stringify(payload) : ''
  const byteLength = Buffer.byteLength(payloadJson, 'utf8')
  if (byteLength > PG_NOTIFY_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `NOTIFY payload exceeds ${PG_NOTIFY_MAX_PAYLOAD_BYTES} bytes (${byteLength})`
    )
  }
  await client.query('SELECT pg_notify($1, $2)', [channel, payloadJson])
}

import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Client, PoolClient } from 'pg'
import { config } from '../config.js'
import { createDedicatedClient } from '../db/index.js'

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
 *
 * Issue #152: every SSE client used to hold its own dedicated pool connection
 * for the life of the stream. Postgres LISTEN/NOTIFY is per-connection, not
 * per-subscriber, so this file now keeps exactly one shared listener
 * connection per process (see `SharedListener` below) and fans notifications
 * out in-process to every connected `StreamClient` — ten, a hundred, or a
 * thousand concurrent streams all cost this process the same one connection.
 */

export interface StreamMessage {
  type: 'heartbeat' | 'notification' | 'error' | 'resync'
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
// indefinitely, holding its socket/file descriptor and queued frames
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
 * Issue #155: process-wide best-known "system frontier" — the highest ledger
 * sequence number carried by any change notification seen so far, seeded
 * from `indexer_cursor.last_ledger` when the shared listener (issue #152)
 * first connects. `null` means cold start / not yet known.
 *
 * Used to (a) seed each newly-connecting client's monotonic SSE `id:`
 * baseline and (b) tell a reconnecting client (via `Last-Event-ID`) whether
 * it may have missed a change while it was away. Exported as a mutable
 * object, the same pattern as `streamLimits`, so tests can drive it directly
 * instead of racing the real indexer.
 */
export const knownLedger: { value: number | null } = { value: null }

/**
 * Parse one NOTIFY payload and fan it out to every connected client
 * subscribed to that channel. Exported (rather than kept as a private method
 * on the listener below) so issue #154's malformed-payload guard and issue
 * #155's ledger tracking can be unit-tested directly, without a real
 * Postgres LISTEN connection.
 *
 * Issue #154: this used to run inside a `pg` event-emitter callback directly
 * on each client's own dedicated connection — a throw there is NOT caught by
 * any surrounding try/catch and becomes an uncaught exception that kills the
 * whole process, taking every connected SSE client down with it.
 * `JSON.parse` throws on anything that isn't valid JSON, and the payload
 * arrives over NOTIFY, which anything with database access (a psql session,
 * a trigger, an operator, a future producer) can send with any content — not
 * just this codebase's own well-formed callers. The parse happens exactly
 * once here (not once per subscriber), so a bad payload logs exactly once
 * whether zero clients or a hundred are subscribed, and a malformed message
 * is dropped rather than propagated. Other listener callbacks in this file
 * were audited for the same shape and don't parse untrusted input, so this
 * is the only guard needed. A blanket process-wide `uncaughtException`
 * handler was considered as defence in depth and deliberately not added — it
 * would mask unrelated bugs behind a generic catch-all instead of fixing the
 * actual unguarded call site, and would leave the process in a possibly
 * inconsistent state rather than just skipping one bad message.
 */
export function dispatchStreamNotification(channel: StreamChannel, rawPayload?: string): void {
  let payload: Record<string, unknown> = {}
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload) as Record<string, unknown>
    } catch (err) {
      console.error(
        `[stream] dropping malformed NOTIFY payload on channel "${channel}": ${(err as Error).message} — payload prefix: ${rawPayload.slice(0, 200)}`
      )
      return
    }
  }

  // Issue #155: track the highest ledger any notification has carried, so a
  // client connecting later starts its `id:` sequence from a meaningful
  // baseline instead of 0, and a reconnecting client can be told whether it
  // missed anything.
  const ledger = payload.ledger
  if (typeof ledger === 'number' && (knownLedger.value === null || ledger > knownLedger.value)) {
    knownLedger.value = ledger
  }

  for (const sc of connectedClients) {
    sc.receiveNotification(channel, payload)
  }
}

/**
 * Issue #152: the single shared Postgres LISTEN connection for this process.
 * Postgres LISTEN/NOTIFY is per-connection, not per-subscriber — one
 * connection can serve every subscriber — so every `StreamClient` fans out
 * from this one connection instead of each holding its own. It is a
 * standalone connection (src/db/index.ts's `createDedicatedClient`), not one
 * checked out of the shared request pool — see `connect()` below for why.
 * Before this fix, each SSE client held its own dedicated pool connection;
 * node-postgres's pool defaults to 10, so ten concurrent SSE clients used to
 * consume all of them, hanging every other request indefinitely, including
 * `/ready` (which cannot even report why, because answering also needs a
 * connection).
 */
class SharedListener {
  private client: Client | null = null
  private connecting: Promise<void> | null = null

  /** Idempotent: connects on first call, a no-op once connected. */
  async ensureStarted(): Promise<void> {
    if (this.client) return
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<void> {
    // Issue #152 (code review): a *standalone* connection (src/db/index.ts's
    // createDedicatedClient), not one checked out of the shared `pool`. This
    // connection is held for the life of the process, so taking it from the
    // pool would permanently consume one of `DB_POOL_MAX`'s slots — exactly
    // the resource contention this fix exists to remove — and would make
    // `pool.end()` on shutdown (src/index.ts) hang forever, since pg-pool
    // only resolves `end()` once every checked-out client is released.
    const client = createDedicatedClient()
    try {
      await client.connect()

      try {
        const cursor = await client.query<{ last_ledger: number | null }>(
          'SELECT last_ledger FROM indexer_cursor WHERE id = 1'
        )
        const seeded = cursor.rows[0]?.last_ledger
        // Guard against moving the frontier backwards (matches
        // dispatchStreamNotification's own guard) — a reconnect can race a
        // NOTIFY that already advanced `knownLedger.value` past this SELECT.
        if (typeof seeded === 'number' && (knownLedger.value === null || seeded > knownLedger.value)) {
          knownLedger.value = seeded
        }
      } catch (err) {
        // Table may not exist yet on a brand-new database — cold start, the
        // same condition /ready treats as `indexer: 'cold_start'`.
        console.error('[stream] shared listener: could not seed known ledger, treating as cold start:', err)
      }

      for (const channel of Object.values(STREAM_CHANNELS)) {
        await client.query(`LISTEN "${channel}"`)
      }
    } catch (err) {
      // Setup failed partway through (connect, or one of the LISTENs) —
      // close this connection rather than leak it, so the retry on the next
      // incoming SSE connection starts clean instead of piling up dead
      // sockets. `this.client` was never assigned, so ensureStarted() will
      // retry connect() from scratch.
      try {
        await client.end()
      } catch {
        // Already closed.
      }
      throw err
    }

    client.on('notification', (msg) => {
      dispatchStreamNotification(msg.channel as StreamChannel, msg.payload)
    })

    client.on('error', (err) => {
      console.error('[stream] shared listener connection error, will reconnect on next request:', err)
      this.client = null
      client.end().catch(() => {
        // Already gone.
      })
    })

    this.client = client
  }

  /** Close the standalone connection on process shutdown (src/index.ts). */
  async shutdown(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await client.end()
    } catch {
      // Already closed.
    }
  }
}

const sharedListener = new SharedListener()

/**
 * Close the shared listener's standalone connection. Call this during
 * graceful shutdown (src/index.ts), before `pool.end()` — the listener's
 * connection is deliberately outside `pool`, so `pool.end()` never waits on
 * it, but it still needs to be closed itself for a clean shutdown.
 */
export async function shutdownSharedListener(): Promise<void> {
  await sharedListener.shutdown()
}

/**
 * Manage a single SSE client connection: SSE framing, backpressure, and the
 * heartbeat/idle timeout. Notification delivery comes from the shared
 * listener's fan-out (issue #152), not from a connection this class owns.
 */
export class StreamClient {
  private reply: FastifyReply
  private channels: Set<StreamChannel> = new Set()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private closed = false
  private releasePromise: Promise<void> | null = null
  // Issue #157: `false` from reply.raw.write() means the stream's internal
  // buffer is above its high-water mark — the caller (us) is supposed to
  // stop writing until 'drain'. `paused` tracks that; frames sent while
  // paused go to `queue` instead of straight to the socket.
  private paused = false
  private queue: string[] = []
  private stallTimer: NodeJS.Timeout | null = null
  // Issue #155: the highest ledger sequence this client has been shown,
  // seeded from the process-wide `knownLedger` at connect time. Used as the
  // SSE `id:` for every frame — monotonic and meaningful (a real ledger
  // sequence, not `Date.now()`), rather than distinct per message.
  private lastSentLedger = 0
  readonly ip: string

  constructor(reply: FastifyReply, ip = 'unknown') {
    this.reply = reply
    this.ip = ip
  }

  /**
   * Set up the SSE response headers and begin accepting fanned-out
   * notifications.
   *
   * `channels` lets a client subscribe to a subset (issue #160's query
   * parameter) — defaults to every broadcast channel, matching the
   * previous unconditional-subscribe behavior for a client that doesn't ask.
   *
   * `lastEventId` is the `Last-Event-ID` header a reconnecting browser
   * resends automatically (issue #155). When present and the process knows
   * a current ledger, the client is told up front whether it may have
   * missed a change while disconnected, via a `resync` event.
   */
  async start(
    channels: readonly StreamChannel[] = Object.values(STREAM_CHANNELS),
    lastEventId?: string
  ): Promise<void> {
    this.reply.header('Content-Type', 'text/event-stream')
    this.reply.header('Cache-Control', 'no-cache')
    this.reply.header('Connection', 'keep-alive')
    this.reply.header('X-Accel-Buffering', 'no') // Disable nginx buffering

    // Issue #157 / #156: idle timeout — closed automatically by Node if the
    // socket sits idle (no reads or writes) this long. Heartbeats every 30s
    // keep a healthy connection alive; a client that never receives anything
    // (dead link, slept laptop) is dropped.
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
    // The shared listener (issue #152) already LISTENs on every channel;
    // this only decides what this client is fanned out.
    for (const channel of channels) {
      this.channels.add(channel)
    }

    // Issue #155: seed this client's id baseline, and tell a reconnecting
    // client whether it missed anything. Skipped when the process doesn't
    // yet know a current ledger (cold start) — there's nothing meaningful to
    // compare against.
    const currentLedger = knownLedger.value
    this.lastSentLedger = currentLedger ?? 0
    if (lastEventId !== undefined && currentLedger !== null) {
      const seenLedger = Number.parseInt(lastEventId, 10)
      const missed = !Number.isFinite(seenLedger) || seenLedger < currentLedger
      this.sendMessage({
        type: 'resync',
        payload: { missed, lastKnownLedger: currentLedger },
        timestamp: Date.now(),
      })
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
  }

  /**
   * Deliver one already-parsed notification fanned out by the shared
   * listener (issue #152), if this client is subscribed to its channel.
   */
  receiveNotification(channel: StreamChannel, payload: Record<string, unknown>): void {
    if (this.closed) return
    if (!this.channels.has(channel)) return

    this.sendMessage({
      type: 'notification',
      channel,
      payload,
      timestamp: Date.now(),
    })
  }

  /**
   * Send a message to the client via SSE, respecting backpressure (issue #157).
   */
  private sendMessage(msg: StreamMessage): void {
    if (this.closed) return

    // Issue #155: advance this client's id baseline whenever a message
    // carries a newer ledger sequence; otherwise repeat the last one
    // (heartbeats and the initial "Connected" message don't carry a ledger
    // of their own, so they report the most recent one this client knows).
    const ledger = msg.payload?.ledger
    if (typeof ledger === 'number' && ledger > this.lastSentLedger) {
      this.lastSentLedger = ledger
    }

    const eventType = msg.type
    const id = `${this.lastSentLedger}`
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

    this.channels.clear()

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
 * Registered as a plain function taking the `app` instance (issue #158)
 * rather than taking an injected Pool — it talks to Postgres only through
 * the module-level `sharedListener` singleton (issue #152).
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

    // Issue #156: reject before setting anything up when over cap. This still
    // bounds concurrent open sockets/memory even though issue #152 means
    // they no longer each cost a database connection.
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

    // Issue #155: a reconnecting EventSource resends the last id it saw via
    // this header automatically.
    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader

    let streamClient: StreamClient | null = null

    try {
      // Issue #152: ensure the one shared LISTEN connection exists; this is
      // a no-op after the first call for the life of the process.
      await sharedListener.ensureStarted()

      streamClient = new StreamClient(reply, ip)
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
      await streamClient.start(channels ?? undefined, lastEventId)
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

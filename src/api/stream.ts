import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Client, PoolClient } from 'pg'
import { config } from '../config.js'
import { createDedicatedClient, pool } from '../db/index.js'
import { logger } from '../logger.js'
import { setCachePolicy } from './cache-policy.js'
import { sseConnectionsGauge, sseConnectionsTotal, sseMessagesTotal } from './metrics.js'

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
  documents: 'documents_changed',
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

// Issue #285: when a heartbeat tick lands while the client is backpressured
// (paused), it's retried with exponential backoff instead of silently
// skipped until the next fixed 30s tick — a brief mobile-network hiccup
// otherwise goes an extra ~30s with no heartbeat, right when the socket is
// least healthy. Deliberately NOT queued via the normal frame `queue`
// (enqueue()'s own doc comment on why heartbeats skip that path still
// applies: repeatedly queuing heartbeat frames onto an already-stalled
// socket only brings the queue-overflow disconnect sooner for no benefit) —
// this instead polls "is the socket writable yet?" at a backing-off
// interval and sends live, the moment it succeeds.
export const HEARTBEAT_RETRY_INITIAL_MS = 1_000
export const HEARTBEAT_RETRY_MAX_MS = 16_000

// Issue #370: when the shared LISTEN connection drops, the listener reconnects
// on its own with exponential backoff (initial, doubling, capped at max)
// instead of waiting for the next incoming GET /api/stream. Mutable so tests
// can shrink the delays.
export const sharedListenerReconnect = {
  initialMs: 1_000,
  maxMs: 30_000,
}

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
  sseConnectionsGauge.set(0)
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
 * Issue #254: track the last reorg ledger height dispatched to clients, to
 * reject out-of-order reorg signals. If the RPC proxy fails over to a node
 * slightly behind the previous primary, an older reorg notification arriving
 * after a newer one would cause clients to unnecessarily rewind their local
 * state. Monotonic reorg height ensures obsolete rewind signals are discarded.
 */
export const lastReorgLedger: { value: number | null } = { value: null }

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

  // Issue #254: reject out-of-order reorg notifications. If a reorg signal
  // carries a ledger height older than one already dispatched, it's stale
  // (e.g., from RPC failover to a delayed node) and must be dropped to
  // prevent clients from rewinding local state unnecessarily.
  const reorgLedger = payload.reorg_ledger
  if (typeof reorgLedger === 'number') {
    if (lastReorgLedger.value !== null && reorgLedger <= lastReorgLedger.value) {
      console.warn(
        `[stream] dropping out-of-order reorg notification: reorg_ledger=${reorgLedger} is not newer than last dispatched=${lastReorgLedger.value}`
      )
      return
    }
    lastReorgLedger.value = reorgLedger
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
  private reconnecting = false
  // Issue #370: automatic reconnect state.
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private stopped = false

  /** Idempotent: connects on first call, a no-op once connected. */
  async ensureStarted(): Promise<void> {
    this.stopped = false
    if (this.client) return
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  /**
   * Issue #370: retry connect() with exponential backoff until it succeeds
   * (or shutdown() is called), so the LISTEN channels are re-established even
   * if no new SSE request ever arrives.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.client || this.connecting) return
    const delay = Math.min(
      sharedListenerReconnect.initialMs * 2 ** this.reconnectAttempt,
      sharedListenerReconnect.maxMs
    )
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      this.ensureStarted().then(
        () => {
          this.reconnectAttempt = 0
        },
        (err) => {
          console.error('[stream] shared listener reconnect failed, will retry:', err)
          this.scheduleReconnect()
        }
      )
    }, delay)
    // Never keep the process alive just to retry.
    this.reconnectTimer.unref?.()
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
        // Issue #289: indexer_cursor now has one row per tailed contract.
        // MAX(last_ledger) matches this frontier's own semantics (the
        // highest ledger carried by any change notification seen so far,
        // regardless of which contract it came from) and is exactly the
        // single-contract behavior when there's only one row.
        const cursor = await client.query<{ max: number | null }>(
          'SELECT MAX(last_ledger) FROM indexer_cursor'
        )
        const seeded = cursor.rows[0]?.max
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

    // Issue #264: catch database connection errors to prevent unhandled
    // rejections that would crash the Node.js process. When the Postgres
    // server restarts or the connection drops, notify all connected SSE
    // clients so they know to reconnect.
    client.on('error', (err) => {
      console.error('[stream] shared listener connection error, reconnecting with backoff:', err)
      
      // Notify all connected SSE clients about the disconnect so they can
      // trigger a client-side reconnect. Send a disconnect message on all
      // channels to ensure every active client receives the signal.
      for (const sc of connectedClients) {
        for (const channel of Object.values(STREAM_CHANNELS)) {
          sc.receiveNotification(channel as StreamChannel, {
            type: 'disconnect',
            reason: 'database_connection_lost',
            message: 'Database connection lost, please reconnect',
          })
        }
      }
      
      // Issue #253: prevent dual listener during reconnection. Lock the
      // reconnection path to ensure the previous client is fully closed
      // before a new one is created. Setting `this.client = null` here
      // means ensureStarted() will reconnect on the next stream request.
      if (this.reconnecting) {
        console.warn('[stream] shared listener reconnect already in progress, ignoring redundant error event')
        return
      }
      this.reconnecting = true
      const deadClient = this.client
      this.client = null
      deadClient?.end().catch(() => {
        // Already gone.
      }).finally(() => {
        this.reconnecting = false
        // Issue #370: don't wait for the next incoming request.
        this.scheduleReconnect()
      })
    })

    this.client = client
  }

  /** Close the standalone connection on process shutdown (src/index.ts). */
  async shutdown(): Promise<void> {
    // Issue #253: wait for any in-progress reconnection to complete before
    // shutting down, to avoid closing a client that's being replaced.
    while (this.reconnecting) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Issue #370: stop any pending automatic reconnect.
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
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
 * Issue #261: Drain all active SSE stream clients before shutdown.
 * Closes all connected clients gracefully, giving them time to complete
 * any in-flight writes before the pool is closed.
 */
export async function drainStreamClients(): Promise<void> {
  const clients = Array.from(connectedClients)
  if (clients.length === 0) return
  
  console.log(`[stream] draining ${clients.length} active SSE client(s)`)
  await Promise.all(clients.map((client) => client.close()))
  console.log('[stream] all SSE clients drained')
}

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
  // Issue #285: exponential-backoff retry for a heartbeat tick that landed
  // while paused. Non-null only while a retry is pending.
  private heartbeatRetryTimer: NodeJS.Timeout | null = null
  private heartbeatRetryDelayMs = HEARTBEAT_RETRY_INITIAL_MS
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
    setCachePolicy(this.reply, 'no-store')
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
      if (this.paused) {
        // Issue #285: don't add another frame to an already-stalled socket's
        // queue (see enqueue()'s doc comment); instead retry with backoff
        // until the socket drains, rather than silently skipping until the
        // next fixed 30s tick.
        this.scheduleHeartbeatRetry()
        return
      }
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
   *
   * `force` (issue #285) bypasses the pause check and attempts a real write
   * regardless of the last-known `paused` state — used only by the heartbeat
   * retry loop, to actually test current writability rather than queuing
   * behind (or trusting a `paused` flag that only updates on the next real
   * `drain` event).
   */
  private sendMessage(msg: StreamMessage, opts: { force?: boolean } = {}): void {
    if (this.closed) return

      // SSE format: event type, id, and data
      this.reply.raw.write(`event: ${eventType}\n`)
      this.reply.raw.write(`id: ${id}\n`)
      this.reply.raw.write(`data: ${data}\n\n`)
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
   * Begins (or is a no-op if already running) an exponential-backoff retry
   * loop for a heartbeat that landed while `paused` (issue #285). Actual
   * disconnection for a client that never recovers is still governed
   * entirely by the existing stall timer (`armStallTimer`,
   * `DRAIN_STALL_DISCONNECT_MS`), armed by whatever write first set
   * `paused` — this loop only ever retries or gives up quietly, never
   * disconnects on its own.
   */
  private scheduleHeartbeatRetry(): void {
    if (this.heartbeatRetryTimer) return
    this.heartbeatRetryDelayMs = HEARTBEAT_RETRY_INITIAL_MS
    this.armHeartbeatRetry()
  }

  private armHeartbeatRetry(): void {
    this.heartbeatRetryTimer = setTimeout(() => {
      this.heartbeatRetryTimer = null
      if (this.closed) return
      // `force: true` attempts a real write regardless of the last-known
      // `paused` value — that flag only updates on the next real 'drain'
      // event, which this retry can't wait on without reintroducing the
      // "silently stuck until something else happens" problem this exists
      // to fix. writeFrame's return-value handling (above) is what actually
      // learns whether the socket is writable now.
      this.sendMessage({ type: 'heartbeat', timestamp: Date.now() }, { force: true })
      if (this.paused) {
        this.heartbeatRetryDelayMs = Math.min(this.heartbeatRetryDelayMs * 2, HEARTBEAT_RETRY_MAX_MS)
        this.armHeartbeatRetry()
      }
    }, this.heartbeatRetryDelayMs)
    if (this.heartbeatRetryTimer.unref) this.heartbeatRetryTimer.unref()
  }

  private clearHeartbeatRetry(): void {
    if (this.heartbeatRetryTimer) {
      clearTimeout(this.heartbeatRetryTimer)
      this.heartbeatRetryTimer = null
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
    this.clearHeartbeatRetry()

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
      sseConnectionsGauge.set(connectedClients.size)
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
      sseConnectionsGauge.set(connectedClients.size)
      sseConnectionsTotal.inc()

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

// Issue #169: count of NOTIFY failures (oversized payload refused, or the
// pg_notify query itself failing) since process start — the failure used to
// go to `console.error` only, with nothing counted and nothing in
// `/api/stats`, so an operator had no way to notice stream clients were
// silently missing updates.
let notificationFailureCount = 0

/** Count of NOTIFY failures since process start (issue #169). Surfaced on `/api/stats`. */
export function getNotificationFailureCount(): number {
  return notificationFailureCount
}

/** Test helper: reset the counter between test cases. */
export function resetNotificationFailureCountForTests(): void {
  notificationFailureCount = 0
}

/**
 * Emit a NOTIFY to all listening clients (called from the indexer after a transaction commits).
 * This is non-blocking and safe to call from within a transaction — the NOTIFY will be
 * sent when the transaction commits.
 *
 * Issue #153: uses `pg_notify($1, $2)` with bound parameters — no string
 * concatenation / hand-rolled escaping. Payloads over 8000 bytes are refused.
 *
 * Issue #169: prefer `notifyStreamClientsAfterCommit` below for the indexer
 * fold path. This variant still takes the caller's own `client` and is kept
 * for callers that genuinely need the NOTIFY queued inside their own
 * transaction (Postgres only delivers a NOTIFY sent mid-transaction once
 * that transaction commits) — but a failure here can leave `client`'s
 * transaction unusable for whatever statement runs after it, for some
 * Postgres error classes. Callers that don't need that exact guarantee
 * should use `notifyStreamClientsAfterCommit` instead, which can't affect
 * the fold at all because it runs after the fold's transaction already
 * committed.
 */
export async function notifyStreamClients(
  client: PoolClient,
  channel: StreamChannel,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const payloadJson = payload ? JSON.stringify(payload) : ''
    // `NOTIFY` does not accept bind parameters; pg_notify() does, and is
    // equally transactional (delivered on commit).
    await client.query('SELECT pg_notify($1, $2)', [channel, payloadJson])
  } catch (err) {
    // Log but don't throw — notification failure shouldn't break the indexer
    notificationFailureCount += 1
    logger.error('NOTIFY failed', { channel, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Emit a NOTIFY on a connection entirely separate from the fold transaction
 * that produced it (issue #169) — a fresh connection checked out of the
 * shared request pool, used once, and released. Call this only after the
 * fold's own transaction has already committed: by then the derived-table
 * writes are durable, so a NOTIFY failure here is purely a delivery problem
 * for connected stream clients, and categorically cannot roll back or
 * poison the fold. This is what `src/indexer/poller.ts` and
 * `src/indexer/reindex.ts` call once their transaction commits, instead of
 * `applyEvent` notifying inline on the transaction's own client.
 */
export async function notifyStreamClientsAfterCommit(
  channel: StreamChannel,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const payloadJson = payload ? JSON.stringify(payload) : ''
    const byteLength = Buffer.byteLength(payloadJson, 'utf8')
    if (byteLength > PG_NOTIFY_MAX_PAYLOAD_BYTES) {
      notificationFailureCount += 1
      logger.error('NOTIFY payload exceeds size limit; refusing', {
        channel,
        byteLength,
        limitBytes: PG_NOTIFY_MAX_PAYLOAD_BYTES,
      })
      return
    }
    await pool.query('SELECT pg_notify($1, $2)', [channel, payloadJson])
  } catch (err) {
    notificationFailureCount += 1
    logger.error('NOTIFY failed', { channel, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Broadcast a resync notification across all active stream channels defined
 * in STREAM_CHANNELS safely, ensuring individual channel failures do not prevent
 * other channels from receiving the notification.
 */
export async function broadcastResyncToAllChannels(payload?: Record<string, unknown>): Promise<void> {
  for (const channel of Object.values(STREAM_CHANNELS)) {
    try {
      await notifyStreamClientsAfterCommit(channel, payload)
    } catch {
      // Best-effort per channel; continue broadcasting to remaining channels.
    }
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

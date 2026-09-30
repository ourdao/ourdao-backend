/**
 * Prometheus metrics for the SSE stream (issue #274).
 *
 * Registered on a private registry rather than the global default one, so the
 * counters are not shared with any other module that happens to use
 * prom-client, and so tests can read the values back without depending on
 * global state.
 *
 * The metric names and labels are deliberately small: an operator needs to
 * answer "how many clients are connected" and "is the broadcast rate
 * collapsing" during a deploy, not to slice by every dimension available.
 */

import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client'

export const streamRegistry = new Registry()

// Process-level metrics (event loop lag, RSS, GC) come for free and are what
// an operator checks first when the stream looks slow.
collectDefaultMetrics({ register: streamRegistry })

/**
 * Open SSE connections on this process.
 *
 * A gauge, not a counter: it goes down when a client disconnects, and the
 * useful reading is the current value. It is incremented on connect and
 * decremented on close, so it should always equal `getConnectedStreamCount()`.
 */
export const sseActiveConnections = new Gauge({
  name: 'sse_active_connections',
  help: 'Number of currently open SSE stream connections',
  registers: [streamRegistry],
})

/**
 * Messages written to a client, by channel.
 *
 * Counts frames actually written to the socket (including the initial
 * "Connected" frame and heartbeats), which is what a throughput graph needs.
 * A message queued because the socket is backpressured is counted when it is
 * written, not when it is queued, so the counter never claims a message was
 * delivered that is still sitting in the queue.
 */
export const sseMessagesBroadcastTotal = new Counter({
  name: 'sse_messages_broadcast_total',
  help: 'Total SSE messages written to clients, by channel',
  labelNames: ['channel'] as const,
  registers: [streamRegistry],
})

/**
 * Connections closed, by reason.
 *
 * The reason matters more than the total during a deploy: a spike in
 * `idle_timeout` or `drain_stall` means clients are not reading, while a
 * spike in `client_closed` is normal churn. Labels are a fixed set, so the
 * cardinality stays bounded.
 */
export const sseDisconnectsTotal = new Counter({
  name: 'sse_disconnects_total',
  help: 'Total SSE connections closed, by reason',
  labelNames: ['reason'] as const,
  registers: [streamRegistry],
})

/** Reasons a connection can end. Kept as a union so a typo is a type error. */
export type DisconnectReason =
  | 'client_closed'
  | 'idle_timeout'
  | 'drain_stall'
  | 'server_shutdown'
  | 'write_error'

/**
 * Render the registry in the Prometheus text exposition format.
 *
 * Returns a string rather than a response so the caller decides the content
 * type and status code.
 */
export function renderStreamMetrics(): Promise<string> {
  return streamRegistry.metrics()
}

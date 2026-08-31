import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Pool } from 'pg'
import type { PoolClient } from 'pg'

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
 */
export const STREAM_CHANNELS = {
  members: 'members_changed',
  loan_proposals: 'loan_proposals_changed',
  loans: 'loans_changed',
  treasury_proposals: 'treasury_proposals_changed',
  interest: 'interest_changed',
  notifications: 'notifications_changed',
} as const

export type StreamChannel = typeof STREAM_CHANNELS[keyof typeof STREAM_CHANNELS]

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

  constructor(reply: FastifyReply, client: PoolClient) {
    this.reply = reply
    this.client = client
  }

  /**
   * Set up the SSE response headers and begin listening for notifications.
   */
  async start(): Promise<void> {
    this.reply.header('Content-Type', 'text/event-stream')
    this.reply.header('Cache-Control', 'no-cache')
    this.reply.header('Connection', 'keep-alive')
    this.reply.header('X-Accel-Buffering', 'no') // Disable nginx buffering

    // Subscribe to all relevant channels
    const channelList = Object.values(STREAM_CHANNELS)
    for (const channel of channelList) {
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
      if (!this.closed) {
        this.sendMessage({
          type: 'heartbeat',
          timestamp: Date.now(),
        })
      }
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
        this.close()
      }
    })
  }

  /**
   * Send a message to the client via SSE.
   */
  private sendMessage(msg: StreamMessage): void {
    try {
      const eventType = msg.type
      const id = `${msg.timestamp}`
      const data = JSON.stringify({
        type: msg.type,
        channel: msg.channel,
        payload: msg.payload,
        timestamp: msg.timestamp,
      })

      // SSE format: event type, id, and data
      this.reply.raw.write(`event: ${eventType}\n`)
      this.reply.raw.write(`id: ${id}\n`)
      this.reply.raw.write(`data: ${data}\n\n`)
    } catch (err) {
      // Ignore write errors (client disconnected)
      if (this.reply.raw.destroyed) {
        this.closed = true
      }
    }
  }

  /**
   * Clean up resources and close the connection.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

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

    // Close the client
    try {
      this.client.release()
    } catch {
      // Ignore errors during cleanup
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
 * Register the /api/stream endpoint.
 * Returns a Server-Sent Events stream of change notifications.
 */
export async function registerStreamEndpoint(app: FastifyInstance, pool: Pool): Promise<void> {
  // Track connected clients for optional metrics/admin
  const connectedClients = new Set<StreamClient>()

  app.get('/api/stream', async (request, reply) => {
    let streamClient: StreamClient | null = null

    try {
      // Dedicated connection for LISTEN/NOTIFY; StreamClient owns its release.
      const client = await pool.connect()
      streamClient = new StreamClient(reply, client)
      connectedClients.add(streamClient)

      // Handle client disconnect
      reply.raw.on('close', async () => {
        connectedClients.delete(streamClient!)
        await streamClient!.close()
      })

      reply.raw.on('error', async () => {
        connectedClients.delete(streamClient!)
        await streamClient!.close()
      })

      // Start the stream
      await streamClient.start()
    } catch (err) {
      connectedClients.delete(streamClient!)
      if (streamClient) {
        await streamClient.close()
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
 */
export async function notifyStreamClients(
  client: PoolClient,
  channel: StreamChannel,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    const payloadJson = payload ? JSON.stringify(payload) : ''
    const escapedPayload = payloadJson.replace(/'/g, "''")
    await client.query(`NOTIFY "${channel}", '${escapedPayload}'`)
  } catch (err) {
    // Log but don't throw — notification failure shouldn't break the indexer
    console.error('[stream] NOTIFY error:', err)
  }
}

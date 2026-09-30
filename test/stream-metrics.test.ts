import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'
import {
  STREAM_CHANNELS,
  StreamClient,
  getConnectedStreamCount,
  resetConnectedStreamsForTests,
  shutdownSharedListener,
  trackStreamClientForTests,
} from '../src/api/stream.js'
import { renderStreamMetrics } from '../src/api/stream-metrics.js'

// Minimal fake of the FastifyReply surface StreamClient touches. Same approach
// as api-stream.test.ts: a real socket is slow and its timing is not
// deterministic to assert against.
function makeFakeStreamPair() {
  const raw = {
    write: () => true,
    end: () => {},
    destroyed: false,
    setTimeout: () => {},
    on: () => {},
  }
  return { reply: { header: () => {}, raw } as unknown as FastifyReply, raw }
}

/** Read a counter's current value for a label set. */
async function counterValue(
  metric: string,
  labels: Record<string, string> = {}
): Promise<number> {
  const text = await renderStreamMetrics()
  const labelPart = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')
  const line = text
    .split('\n')
    .find((l) =>
      labelPart === ''
        ? l.startsWith(`${metric} `)
        : l.startsWith(`${metric}{${labelPart}} `)
    )
  if (!line) return 0
  return Number(line.slice(line.lastIndexOf(' ') + 1))
}

/** Read a gauge's current value. */
async function gaugeValue(metric: string): Promise<number> {
  const text = await renderStreamMetrics()
  const line = text.split('\n').find((l) => l.startsWith(`${metric} `))
  if (!line) return 0
  return Number(line.slice(line.lastIndexOf(' ') + 1))
}

/** A started client, registered exactly the way the endpoint registers one. */
async function trackedClient(channels: readonly string[] = [STREAM_CHANNELS.loans]) {
  const { reply } = makeFakeStreamPair()
  const client = new StreamClient(reply)
  await client.start(channels as never)
  trackStreamClientForTests(client)
  return client
}

describe('SSE stream metrics (issue #274)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    resetConnectedStreamsForTests()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    resetConnectedStreamsForTests()
    await shutdownSharedListener()
    closeDb()
  })

  it('registers the three metric names the issue asks for', async () => {
    const text = await renderStreamMetrics()

    expect(text).toContain('sse_active_connections')
    expect(text).toContain('sse_messages_broadcast_total')
    expect(text).toContain('sse_disconnects_total')
  })

  it('GET /metrics serves the Prometheus text exposition format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    // The registry is scraped as text, not JSON.
    expect(res.body).toContain('# HELP sse_active_connections')
    expect(res.body).toContain('# TYPE sse_active_connections gauge')
  })

  it('the active-connections gauge matches the tracked stream count', async () => {
    const client = await trackedClient()

    expect(getConnectedStreamCount()).toBe(1)
    expect(await gaugeValue('sse_active_connections')).toBe(1)

    await client.close()
  })

  it('increments the broadcast counter with the message channel', async () => {
    const before = await counterValue('sse_messages_broadcast_total', {
      channel: STREAM_CHANNELS.loans,
    })

    const client = await trackedClient([STREAM_CHANNELS.loans])
    client.receiveNotification(STREAM_CHANNELS.loans, { ledger: 42 })

    const after = await counterValue('sse_messages_broadcast_total', {
      channel: STREAM_CHANNELS.loans,
    })

    expect(after).toBe(before + 1)
    await client.close()
  })

  it('does not count a message for a channel the client did not subscribe to', async () => {
    const client = await trackedClient([STREAM_CHANNELS.loans])

    const before = await counterValue('sse_messages_broadcast_total', {
      channel: STREAM_CHANNELS.treasury_proposals,
    })
    client.receiveNotification(STREAM_CHANNELS.treasury_proposals, { ledger: 43 })
    const after = await counterValue('sse_messages_broadcast_total', {
      channel: STREAM_CHANNELS.treasury_proposals,
    })

    expect(after).toBe(before)
    await client.close()
  })

  it('records a disconnect with a reason and drops the gauge', async () => {
    const before = await counterValue('sse_disconnects_total', {
      reason: 'client_closed',
    })

    const client = await trackedClient()
    expect(await gaugeValue('sse_active_connections')).toBe(1)

    await client.close()

    expect(
      await counterValue('sse_disconnects_total', { reason: 'client_closed' })
    ).toBe(before + 1)
    // The gauge is back to zero: the closed client no longer counts.
    expect(await gaugeValue('sse_active_connections')).toBe(0)
  })

  it('does not double count when close() is called twice', async () => {
    const client = await trackedClient()

    const before = await counterValue('sse_disconnects_total', {
      reason: 'client_closed',
    })

    // close() is idempotent (issue #159) — the metric must be too, or the
    // total inflates and the gauge drifts negative.
    await client.close()
    await client.close()

    expect(
      await counterValue('sse_disconnects_total', { reason: 'client_closed' })
    ).toBe(before + 1)
    expect(await gaugeValue('sse_active_connections')).toBe(0)
  })

  it('labels a backpressure stall disconnect as drain_stall', async () => {
    const client = await trackedClient()

    const before = await counterValue('sse_disconnects_total', {
      reason: 'drain_stall',
    })

    // Reach into the private marker the stall timer uses; the timer itself is
    // 30s, which no test should wait for.
    ;(client as unknown as { markDisconnect: (r: string) => void }).markDisconnect(
      'drain_stall'
    )
    await client.close()

    expect(
      await counterValue('sse_disconnects_total', { reason: 'drain_stall' })
    ).toBe(before + 1)
  })

  it('exports process-level metrics alongside the stream ones', async () => {
    // collectDefaultMetrics is what gives an operator event-loop lag and RSS
    // for free; asserting one of them keeps that wiring from silently breaking.
    const text = await renderStreamMetrics()
    expect(text).toMatch(/process_resident_memory_bytes|nodejs_eventloop_lag/)
  })
})

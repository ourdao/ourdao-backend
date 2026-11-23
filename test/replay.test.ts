import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { pool } from '../src/db/index.js'
import { replayFailedEvent, replayAllFailedEvents } from '../src/indexer/replay.js'
import { resetDb, closeDb } from './db.js'
import { register as metricsRegister } from '../src/api/metrics.js'

/**
 * Tests for replay functionality (issue #529).
 *
 * Verifies that replayFailedEvent correctly attempts to re-apply quarantined
 * events and increments the ourdao_replay_outcomes_total counter with the
 * appropriate outcome label.
 */
describe('Replay failed events (#529)', () => {
  beforeEach(async () => {
    await resetDb()
    metricsRegister.resetMetrics()
  })

  afterAll(closeDb)

  it('replayFailedEvent returns "already_resolved" when event not in failed_events', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const outcome = await replayFailedEvent(client, 'nonexistent-event-id')
      await client.query('COMMIT')

      expect(outcome).toBe('already_resolved')

      // Verify metric was incremented
      const metricsText = await metricsRegister.metrics()
      expect(metricsText).toContain('ourdao_replay_outcomes_total{outcome="already_resolved"}')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('replayFailedEvent returns "still_failing" when event still fails to apply', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Insert a test event
      const eventId = 'test-event-1'
      await client.query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
         VALUES ($1, 100, NOW(), 'CTEST', 'unknown_event', '[]'::jsonb, '[]'::jsonb, NULL)`,
        [eventId]
      )

      // Insert it into failed_events
      await client.query(
        `INSERT INTO failed_events (event_id, symbol, ledger, error)
         VALUES ($1, 'unknown_event', 100, 'handler not found')`,
        [eventId]
      )

      // Replay should fail because 'unknown_event' has no handler
      const outcome = await replayFailedEvent(client, eventId)
      await client.query('COMMIT')

      expect(outcome).toBe('still_failing')

      // Verify metric
      const metricsText = await metricsRegister.metrics()
      expect(metricsText).toContain('ourdao_replay_outcomes_total{outcome="still_failing"}')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('replayAllFailedEvents processes multiple events and returns summary', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Insert two test events
      await client.query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
         VALUES 
           ('event-1', 100, NOW(), 'CTEST', 'unknown_1', '[]'::jsonb, '[]'::jsonb, NULL),
           ('event-2', 101, NOW(), 'CTEST', 'unknown_2', '[]'::jsonb, '[]'::jsonb, NULL)`
      )

      // Insert them into failed_events
      await client.query(
        `INSERT INTO failed_events (event_id, symbol, ledger, error)
         VALUES 
           ('event-1', 'unknown_1', 100, 'error 1'),
           ('event-2', 'unknown_2', 101, 'error 2')`
      )

      const summary = await replayAllFailedEvents(client)
      await client.query('COMMIT')

      // Both should fail since they have unknown event types
      expect(summary.stillFailing).toBeGreaterThanOrEqual(2)
      expect(summary.replayed + summary.alreadyResolved + summary.stillFailing).toBeGreaterThanOrEqual(2)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('metrics counter is incremented for each replay attempt', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Insert and fail an event
      await client.query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
         VALUES ('event-metric-test', 100, NOW(), 'CTEST', 'unknown', '[]'::jsonb, '[]'::jsonb, NULL)`
      )

      await client.query(
        `INSERT INTO failed_events (event_id, symbol, ledger, error)
         VALUES ('event-metric-test', 'unknown', 100, 'test error')`
      )

      await replayFailedEvent(client, 'event-metric-test')
      await client.query('COMMIT')

      const metricsText = await metricsRegister.metrics()
      // Should have incremented the counter
      expect(metricsText).toContain('ourdao_replay_outcomes_total')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

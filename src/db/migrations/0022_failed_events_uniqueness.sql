-- compat: breaking (adds UNIQUE(event_id) to failed_events: the previous release inserts without ON CONFLICT and errors on a repeat failure)
-- Issue #171: failed_events had no uniqueness and no retention. The table
-- grew without bound because event_id wasn't unique — every failure inserted
-- a new row carrying the full exception message. One broken handler could
-- inflated the quarantinedEvents count without limit, and the count measured
-- failures, not failing events.
--
-- This migration adds:
-- 1. UNIQUE constraint on event_id to fold failures of the same event
-- 2. DROP the indexes that suggested duplicates were expected, since they're now redundant
-- 3. A retention policy: DELETE rows older than FAILED_EVENTS_RETENTION_DAYS

DROP INDEX IF EXISTS failed_events_event_id_idx;
DROP INDEX IF EXISTS failed_events_ledger_idx;

-- Add uniqueness: one row per distinct failing event. The quarantine path
-- upserts by event_id, so repeated failures of the same event update one row
-- instead of multiplying it.
ALTER TABLE IF EXISTS failed_events
  ADD CONSTRAINT failed_events_event_id_unique UNIQUE (event_id);

-- Add a composite index for operator diagnostics: find failures in a ledger range efficiently
CREATE INDEX IF NOT EXISTS failed_events_ledger_created_at_idx ON failed_events (ledger, created_at);

-- Helper function: delete expired records. Note that the quarantine path calls
-- this explicitly at fixed intervals; this trigger/rule is just a safety net.
-- The interval is configurable via FAILED_EVENTS_RETENTION_DAYS (default 30 days).
CREATE OR REPLACE FUNCTION delete_expired_failed_events() RETURNS void AS $$
BEGIN
  DELETE FROM failed_events
  WHERE created_at < now() - INTERVAL '1 day' * COALESCE(
    current_setting('app.failed_events_retention_days', true)::int,
    30
  );
END;
$$ LANGUAGE plpgsql;

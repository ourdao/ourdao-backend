-- compat: breaking (adds a CHECK constraint on failed_events.resolution; no release writes that column before this one, so no existing row can violate it)
-- Issue #287: batch-resolving quarantined failed_events needs somewhere to
-- record *why* (resolved vs deliberately ignored) and an optional operator
-- note, alongside the existing resolved_at timestamp (#168). Both columns
-- are nullable so every pre-existing row (and any resolution recorded
-- outside the new batch endpoint) remains valid without a backfill.
ALTER TABLE failed_events ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE failed_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE failed_events ADD CONSTRAINT failed_events_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('resolved', 'ignored'));

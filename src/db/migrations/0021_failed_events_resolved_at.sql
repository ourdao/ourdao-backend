-- #168 — a reindex re-applies every raw event, so a previously-quarantined
-- event that folds cleanly this time is repaired, but failed_events was
-- never updated to say so: /api/stats.quarantinedEvents kept counting it
-- forever. resolved_at is set (never the row deleted, so the failure
-- history survives) whenever a reindex or a targeted replay (#170)
-- successfully re-folds the event.
--
-- 0021 picked deliberately: this repo has a separate open issue about a
-- duplicate migration version number already having been used once, so a
-- new migration should always double check the highest number actually
-- present under src/db/migrations/ (currently 0020) rather than trusting any
-- gap in the sequence (e.g. the missing 0011/0014) to be the next free slot.

ALTER TABLE failed_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS failed_events_unresolved_idx ON failed_events (id) WHERE resolved_at IS NULL;

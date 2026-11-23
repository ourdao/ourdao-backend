-- Issue #60: Add composite index on (ledger, id) for deterministic paging
CREATE INDEX IF NOT EXISTS events_ledger_id_idx ON events (ledger, id);

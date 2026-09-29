-- compat: backward-compatible
-- Index events.contract_id so /api/events?contract= and /api/admin/log?contract=
-- can scope the raw log to a single deployment. The column has always been
-- populated; nothing filtered on it before (issue #16).
CREATE INDEX IF NOT EXISTS events_contract_id_idx ON events (contract_id);

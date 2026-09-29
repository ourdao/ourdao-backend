-- compat: backward-compatible
-- #43: a deterministically-throwing handler used to wedge the indexer
-- permanently (same page retried forever behind exponential backoff, capped
-- at 60s). The poller now quarantines an event after N consecutive
-- same-page, same-error failures instead of retrying it forever — this
-- table records what was quarantined, without ever mutating or deleting the
-- append-only `events` row it came from.
CREATE TABLE IF NOT EXISTS failed_events (
  id         BIGSERIAL PRIMARY KEY,
  event_id   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  ledger     BIGINT NOT NULL,
  error      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS failed_events_event_id_idx ON failed_events (event_id);
CREATE INDEX IF NOT EXISTS failed_events_ledger_idx ON failed_events (ledger);

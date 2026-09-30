-- compat: backward-compatible
-- Issue #191: persist a detected ledger discontinuity so it is visible over
-- the API (not only in logs) and so a restarted worker refuses to resume
-- past it until an operator clears it. One row per halt; `cleared_at` is set
-- by `npm run reindex` or `npm run reorg:clear`.
CREATE TABLE IF NOT EXISTS reorg_halts (
  id               BIGSERIAL PRIMARY KEY,
  contract_id      TEXT NOT NULL,
  last_ledger      BIGINT,
  last_ledger_hash TEXT,
  detail           TEXT NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at       TIMESTAMPTZ,
  cleared_by       TEXT
);
CREATE INDEX IF NOT EXISTS reorg_halts_uncleared_idx ON reorg_halts (id DESC) WHERE cleared_at IS NULL;

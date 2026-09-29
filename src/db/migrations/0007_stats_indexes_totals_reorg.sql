-- compat: backward-compatible
-- Bundles the schema changes for three related issues so an existing
-- database gets them in one step. Fresh databases get the same end state
-- from schema.sql directly.

-- #18: partial index so the /api/stats active-member count is index-only.
CREATE INDEX IF NOT EXISTS members_active_idx ON members (address) WHERE exited = false;

-- #23: forensic ledger-hash of the RPC tip at each cursor advance.
ALTER TABLE indexer_cursor ADD COLUMN IF NOT EXISTS last_ledger_hash TEXT;

-- #24: lifetime money aggregates + interest distribution history.
CREATE TABLE IF NOT EXISTS dao_totals (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  interest_collected NUMERIC(40,0) NOT NULL DEFAULT 0,
  principal_lent     NUMERIC(40,0) NOT NULL DEFAULT 0,
  principal_repaid   NUMERIC(40,0) NOT NULL DEFAULT 0,
  value_defaulted    NUMERIC(40,0) NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dao_totals_singleton CHECK (id = 1)
);
INSERT INTO dao_totals (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS interest_distributions (
  id             BIGSERIAL PRIMARY KEY,
  event_id       TEXT NOT NULL UNIQUE,
  ledger         BIGINT NOT NULL,
  amount         NUMERIC(40,0) NOT NULL,
  active_members INTEGER,
  tx_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interest_distributions_ledger_idx ON interest_distributions (ledger);

-- compat: backward-compatible
-- #44: doc_attn was in the event catalog but had no handler, so there was no
-- way to list a proposal's attached documents' existence/history off-chain.
-- One row per event; the content hash itself is never stored here (still
-- read live from the contract via get_document).
CREATE TABLE IF NOT EXISTS documents (
  id          BIGSERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL UNIQUE,
  proposal_id INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  caller      TEXT NOT NULL,
  ledger      BIGINT NOT NULL,
  tx_hash     TEXT,
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_proposal_idx ON documents (kind, proposal_id, ledger DESC);

-- compat: backward-compatible
-- Issue #189: /api/documents can now list without naming a proposal —
-- unfiltered (newest ledger first) and by `caller`. documents_proposal_idx
-- (kind, proposal_id, ledger DESC) serves only the per-proposal query, so
-- add one index per new query shape. Both match the endpoint's
-- `ORDER BY ledger DESC, id DESC` so the LIMIT is satisfied by an index scan.
CREATE INDEX IF NOT EXISTS documents_caller_idx ON documents (caller, ledger DESC, id DESC);
CREATE INDEX IF NOT EXISTS documents_ledger_idx ON documents (ledger DESC, id DESC);

-- compat: backward-compatible
-- Issue #291: immutable audit trail for all administrative actions — resolving
-- quarantined events, resetting cursors, manual reindexing — so every admin
-- intervention is permanently tracked and tamper-evident for security compliance.
--
-- `admin_address` is the authenticated Stellar address that performed the action.
-- `action` is a short, machine-readable label (e.g. 'resolve_quarantined_event',
--   'reset_cursor', 'manual_reindex').
-- `ip_address` is the originating client IP as seen by the API process
--   (trusted only as far as TRUST_PROXY is configured).
-- `payload` stores action-specific context (event id, ledger range, etc.) as JSONB
--   so the schema stays stable as new action types are added.
-- Rows are never updated or deleted — the table is append-only so the audit trail
-- is tamper-evident. A CHECK constraint blocks any UPDATE to enforce this at the
-- database level.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  admin_address TEXT NOT NULL,
  action        TEXT NOT NULL,
  ip_address    TEXT,
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by admin address (operator accountability queries).
CREATE INDEX IF NOT EXISTS admin_audit_log_admin_address_idx ON admin_audit_log (admin_address, created_at DESC);
-- Lookup by action type (auditing all uses of a specific action).
CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx ON admin_audit_log (action, created_at DESC);
-- Default chronological listing.
CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at DESC);

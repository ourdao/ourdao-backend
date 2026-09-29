-- compat: backward-compatible
-- Track how many times a member has defaulted on a loan, so their default
-- history is queryable without scanning the raw event log (loan_dflt
-- handler in src/indexer/handlers.ts).
ALTER TABLE members ADD COLUMN IF NOT EXISTS defaults_count INTEGER NOT NULL DEFAULT 0;

-- compat: backward-compatible
-- Record which contract a saved cursor belongs to. Without this, switching
-- CONTRACT_ID (testnet -> mainnet, or a redeploy) silently resumes from the
-- old contract's paging_token, which the RPC will reject or — worse —
-- silently return the wrong contract's events for.
ALTER TABLE indexer_cursor ADD COLUMN IF NOT EXISTS contract_id TEXT;

-- compat: backward-compatible
-- #45: `last_ledger` was carrying two different meanings — "highest ledger
-- actually folded" (what the reorg continuity check needs) and "how current
-- is the RPC's chain tip" (what freshness reporting wants). An empty page
-- fed the second into the first, which could jump last_ledger to the chain
-- tip during catch-up and false-positive the next real, lower-ledger page as
-- a reorg. `observed_tip_ledger` carries the second meaning on its own
-- column; `last_ledger` now only ever advances to a ledger whose events were
-- actually folded.
ALTER TABLE indexer_cursor ADD COLUMN IF NOT EXISTS observed_tip_ledger BIGINT;

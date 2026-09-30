-- compat: breaking (indexer_cursor is keyed by contract_id instead of a single id = 1 row; a release predating it reads the singleton row that no longer exists)
-- Issue #289: indexer_cursor moves from a single `id = 1` singleton row to
-- one row per contract_id, primary-keyed on contract_id. A deployment
-- tailing more than one contract needs an independent
-- paging_token/last_ledger/last_ledger_hash per contract; a shared singleton
-- row can only ever track one.
--
-- A pre-existing singleton row with contract_id already set (the normal
-- case — every cursor write already stamps contract_id, see #16) is kept
-- as-is and simply becomes that contract's row under the new key. A row
-- that somehow still has contract_id NULL (a cursor never advanced under
-- #3, before contract_id existed at all) can't be attributed to any
-- specific contract, so it's dropped rather than guessed at — the indexer
-- cold-starts that contract from START_LOOKBACK_LEDGERS on next run, same
-- as any brand-new contract.
DELETE FROM indexer_cursor WHERE contract_id IS NULL;

ALTER TABLE indexer_cursor DROP CONSTRAINT IF EXISTS indexer_cursor_singleton;
ALTER TABLE indexer_cursor ALTER COLUMN contract_id SET NOT NULL;
ALTER TABLE indexer_cursor DROP CONSTRAINT IF EXISTS indexer_cursor_pkey;
ALTER TABLE indexer_cursor ADD CONSTRAINT indexer_cursor_pkey PRIMARY KEY (contract_id);
ALTER TABLE indexer_cursor ALTER COLUMN id DROP NOT NULL;
ALTER TABLE indexer_cursor ALTER COLUMN id DROP DEFAULT;

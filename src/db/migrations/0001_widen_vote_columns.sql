-- compat: breaking (column type change INTEGER -> NUMERIC(40,0): the previous release reads votes_* as numbers, this schema returns strings)
-- Widen vote tallies from INTEGER to NUMERIC(40,0), matching every other
-- on-chain-derived amount in this schema. INTEGER tops out at ~2.1e9; a
-- stake-weighted tally can exceed that even though a per-member +1 count
-- currently can't, and the column type needs to be ready before the
-- indexer logic that fills it changes.
ALTER TABLE loan_proposals
  ALTER COLUMN votes_for     TYPE NUMERIC(40,0),
  ALTER COLUMN votes_against TYPE NUMERIC(40,0);

ALTER TABLE treasury_proposals
  ALTER COLUMN votes_for     TYPE NUMERIC(40,0),
  ALTER COLUMN votes_against TYPE NUMERIC(40,0);

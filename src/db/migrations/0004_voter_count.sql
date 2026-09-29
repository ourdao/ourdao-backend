-- compat: backward-compatible
-- Track a distinct-voter headcount alongside the stake-weighted tally, so a
-- client can show both "7 members voted" and "carrying 19 voting power"
-- (see the Event catalog section of the README).
ALTER TABLE loan_proposals ADD COLUMN IF NOT EXISTS voter_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasury_proposals ADD COLUMN IF NOT EXISTS voter_count INTEGER NOT NULL DEFAULT 0;

-- compat: backward-compatible
-- Issue #26: per-loan / per-proposal / per-member event timelines.
--
-- The timeline endpoints filter the append-only `events` log by the entity id
-- carried inside the JSONB `data` tuple. For every loan- and treasury-
-- lifecycle event that id (named `id` / `proposal_id` / `loan_id` depending
-- on the symbol) is the first tuple entry, so a btree expression index on the
-- extracted `data->>0` value makes `GET /api/loans/:id/timeline` and
-- `GET /api/proposals/treasury/:id/timeline` index scans rather than seq
-- scans of the whole log. EXPLAIN output on a seeded dataset is in the PR.
CREATE INDEX IF NOT EXISTS events_entity_id_idx ON events ((data->>0));

-- `GET /api/members/:address/activity` matches a member address in any
-- position of the `data` tuple (borrower / voter / member differ per symbol),
-- so it uses JSONB containment (`data @> '"G…"'`) which a jsonb_path_ops GIN
-- index accelerates.
CREATE INDEX IF NOT EXISTS events_data_gin_idx ON events USING GIN (data jsonb_path_ops);

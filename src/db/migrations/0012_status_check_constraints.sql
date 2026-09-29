-- compat: breaking (adds CHECK constraints: a previous release that writes a status outside the set is now rejected, and rolling back cannot remove them)
-- #73 — the loan_proposals / loans / treasury_proposals `status` columns were
-- bare TEXT with no CHECK. A typo in a handler (`'Repaid'`, `'defaulted '`)
-- would persist silently and then quietly under-report through
-- `/api/loans?status=` and `/api/stats`'s `count(*) WHERE status = …`, and
-- `npm run reindex` would rewrite the bad value on every rebuild.
--
-- Constrain each column to exactly its documented set. The value lists here
-- are identical to the inline constraints in schema.sql (fresh databases) and
-- to the TypeScript unions in src/types.ts; test/status-constraints.test.ts
-- fails if any of the three drift apart.
--
-- `'cancelled'` is included deliberately: it is a declared LoanProposalStatus
-- that no handler writes yet (the loan_exp work will use it for expired
-- proposals), so it belongs in the accepted set rather than being dropped.
--
-- Pre-flight: every `status` value in this schema is written by a handler as a
-- TypeScript string literal (grep `status =` / `status:` in
-- src/indexer/handlers.ts), so existing rows already satisfy these. If a
-- deploy did hit dirty data, `ADD CONSTRAINT` fails loudly inside migrate()'s
-- per-migration transaction (it rolls back, the boot aborts) — the fix then is
-- a one-off `UPDATE … SET status = …` mapping the stray values before
-- re-running, not `NOT VALID`.

ALTER TABLE loan_proposals
  ADD CONSTRAINT loan_proposals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));

ALTER TABLE loans
  ADD CONSTRAINT loans_status_check
  CHECK (status IN ('active', 'repaid', 'defaulted'));

ALTER TABLE treasury_proposals
  ADD CONSTRAINT treasury_proposals_status_check
  CHECK (status IN ('pending', 'executed', 'rejected'));

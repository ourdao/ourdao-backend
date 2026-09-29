-- compat: backward-compatible
-- Add the total owed and due date to disbursed loans. `total_repayment` is
-- already tracked on the originating loan_proposals row (set at loan_req /
-- loan_edit time); loans didn't carry it forward. `due_time` has no source
-- yet in the indexed event data — it's added nullable so it can be
-- populated once a contract event supplies it.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS total_repayment NUMERIC(40,0) NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS due_time TIMESTAMPTZ;

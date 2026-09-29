-- compat: backward-compatible
-- Issue #172: Move quarantine failure counter to persistent storage so a crash
-- loop still escalates to quarantine. Previous state lived only in memory — a
-- restart reset the counter, letting a deterministic failure that had failed
-- twice be retried again after deploy, never reaching the threshold.
--
-- Issue #174: Track when quarantine last escalated as a threshold for alerting
-- — an operator should know when the quarantine count rises from zero to
-- non-zero, signaling data loss in a derived table.

CREATE TABLE IF NOT EXISTS quarantine_state (
  id        SMALLINT PRIMARY KEY DEFAULT 1,
  page_key  TEXT,
  error_message TEXT,
  failures  INT NOT NULL DEFAULT 1,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Issue #174: Track escalation points for alerting
CREATE INDEX IF NOT EXISTS quarantine_state_escalated_at_idx ON quarantine_state (escalated_at);

-- compat: backward-compatible
-- Pre-aggregated UTC daily loan metrics for GET /api/stats/history.
CREATE TABLE IF NOT EXISTS daily_loan_stats (
  day                 DATE PRIMARY KEY,
  loans_originated    INTEGER NOT NULL DEFAULT 0,
  principal_lent      NUMERIC(40,0) NOT NULL DEFAULT 0,
  principal_repaid    NUMERIC(40,0) NOT NULL DEFAULT 0,
  defaults_count      INTEGER NOT NULL DEFAULT 0,
  value_defaulted     NUMERIC(40,0) NOT NULL DEFAULT 0
);

WITH originations AS (
  SELECT DISTINCT ON (e.data->>0)
         (e.closed_at AT TIME ZONE 'UTC')::date AS day,
         (e.data->>2)::numeric AS amount
    FROM events e
   WHERE e.symbol = 'loan_appr'
   ORDER BY e.data->>0, e.ledger, e.id
), repayments AS (
  SELECT DISTINCT ON (e.data->>0)
         (e.closed_at AT TIME ZONE 'UTC')::date AS day,
         l.amount
    FROM events e
    JOIN loans l ON l.id::text = e.data->>0
   WHERE e.symbol = 'loan_rpy' AND e.data->>2 = '0'
   ORDER BY e.data->>0, e.ledger, e.id
), defaults AS (
  SELECT DISTINCT ON (e.data->>0)
         (e.closed_at AT TIME ZONE 'UTC')::date AS day,
         l.outstanding AS amount
    FROM events e
    JOIN loans l ON l.id::text = e.data->>0
   WHERE e.symbol = 'loan_dflt'
   ORDER BY e.data->>0, e.ledger, e.id
), movements AS (
  SELECT day, 'originated' AS kind, amount FROM originations
  UNION ALL
  SELECT day, 'repaid' AS kind, amount FROM repayments
  UNION ALL
  SELECT day, 'defaulted' AS kind, amount FROM defaults
)
INSERT INTO daily_loan_stats
  (day, loans_originated, principal_lent, principal_repaid, defaults_count, value_defaulted)
SELECT day,
       count(*) FILTER (WHERE kind = 'originated')::integer,
       COALESCE(sum(amount) FILTER (WHERE kind = 'originated'), 0),
       COALESCE(sum(amount) FILTER (WHERE kind = 'repaid'), 0),
       count(*) FILTER (WHERE kind = 'defaulted')::integer,
       COALESCE(sum(amount) FILTER (WHERE kind = 'defaulted'), 0)
  FROM movements
 GROUP BY day
ON CONFLICT (day) DO NOTHING;

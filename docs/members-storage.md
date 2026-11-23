# `members` — growth, storage, and the `/api/members` sort (issue #514)

`GET /api/members` runs

```sql
SELECT * FROM members
 WHERE exited = false AND joined_ledger IS NOT NULL
 ORDER BY joined_ledger DESC NULLS LAST LIMIT $1
```

which is a full scan plus a sort: nothing in the current schema provides
`joined_ledger` order over the live set. Issue #277's comment calls it
"heavy enough (full table scan + sort) to be worth a short-lived read-through
cache", and `src/cache` wraps it accordingly. This document is the measurement
that comment never had: row size, growth, the plan with and without a
supporting index, and the point at which a schema change stops being
speculative — the same exercise `docs/events-storage.md` does for `events`.

> **Measure on your own hardware.** The figures below are from a throwaway
> Postgres 16 database (`postgres:16-alpine`) on a development machine,
> seeded with realistic rows (10% phantom addresses that never joined, 20% of
> real members exited, monotonic `joined_ledger`, ~33% name coverage) and
> measured with `EXPLAIN (ANALYZE, FORMAT JSON)`, median of 7 runs at
> `LIMIT 50`. Re-run before choosing a design; the shape of the conclusion
> matters more than the milliseconds.

## Row-size model

Per `members` row (`src/db/schema.sql`):

| Column | Type | Typical bytes |
|---|---|---|
| `address` | `TEXT` primary key (`G…` strkey, 56 chars) | ~58 |
| `joined_ledger` | `BIGINT`, NULL for phantom rows | 8 |
| `contribution` | `NUMERIC(40,0)` | ~24 |
| `exited` | `BOOLEAN` | 1 |
| `exit_share` | `NUMERIC(40,0)` NULL for active members | 0–24 |
| `exited_ledger` | `BIGINT` NULL for active members | 0–8 |
| `pending_claimed` | `NUMERIC(40,0)` | ~24 |
| `stake` | `NUMERIC(40,0)` | ~24 |
| `has_active_loan` | `BOOLEAN` | 1 |
| `name` | `TEXT` NULL for most members, ~9 chars when set | ~2 (avg) |
| `defaults_count` | `INTEGER` | 4 |
| `updated_at` | `TIMESTAMPTZ` | 8 |
| tuple header + null bitmap + line pointer | | ~32 |

**≈ 190–220 bytes/row heap**, plus indexes:

| Index | Purpose | Bytes/row (measured) |
|---|---|---|
| `members_pkey` (`address`) | primary key, point lookup `/api/members/:address` | ~88 |
| `members_active_idx` (`address`) `WHERE exited = false` | `/api/stats` active-count / `sum(stake)` index-only scan | ~70 (80% of rows) |

Measured all-in size (heap + indexes, `pg_total_relation_size`):

| rows | heap | all-in | bytes/row all-in |
|---|---|---|---|
| 5,000 | 704 kB | 1.5 MB | 308 |
| 50,000 | 7.0 MB | 14 MB | 302 |
| 200,000 | 28 MB | 58 MB | 303 |
| 1,000,000 | 139 MB | 290 MB | 304 |

The measured heap is ~140 bytes/row, below the modelled range because
`exit_share`/`exited_ledger`/`name` are NULL for most rows (null bitmap covers
them, no per-row storage). `name` stays inline; nothing here is near the
~2 KB TOAST threshold.

### Growth per unit of activity

| DAO activity | member rows | growth |
|---|---|---|
| one join | 1 INSERT | ~0.3 KB all-in |
| rejoin after exit | UPDATE of the same row | 0 net |
| one `name_reg` / `staked` for a non-member | 0 (issue #14: UPDATE-only) | 0 |
| **1,000 members ever** | 1,000 | **~0.3 MB** |
| **10k members** | — | **~3 MB** |
| **100k members** | — | **~30 MB** |
| **1M members** | — | **~300 MB** |

Unlike `events`, `members` does not grow with loan or vote activity: one row
per address that ever joined, overwritten on rejoin. A busy mainnet DAO with
years of history realistically sits in the tens of thousands of rows, so the
table is an order of magnitude smaller than the event log at every scale.

## Query plan, measured

The exact `/api/members` query at `LIMIT 50`, before and after the candidate

```sql
CREATE INDEX members_join_order_idx
    ON members (exited, joined_ledger DESC)
 WHERE joined_ledger IS NOT NULL;
```

| rows (live) | current plan | median | with candidate index | median |
|---|---|---|---|---|
| 5,000 (4,000) | Seq Scan → Sort → Limit | 6.9 ms | Seq Scan → Sort → Limit (not used) | 3.1 ms |
| 50,000 (40,000) | Seq Scan → Sort → Limit | 23.2 ms | Seq Scan → Sort → Limit (not used) | 22.0 ms |
| 200,000 (160,000) | Parallel Seq Scan → Sort → Gather Merge | 107.5 ms | Parallel Seq Scan → Sort → Gather Merge (not used) | 97.9 ms |
| 1,000,000 (800,000) | Parallel Seq Scan → Sort → Gather Merge | 307.6 ms | Parallel Seq Scan → Sort → Gather Merge (not used) | 426.1 ms |

Example plan at 200k rows (current):

```
Limit  (rows=50, actual time=84.1ms)
  Gather Merge  (rows=50, actual time=84.1ms)
    Sort  (rows=50, actual time=61.1ms)
      Parallel Seq Scan on members  (rows=53333, actual time=30.8ms)
```

**The candidate index as specified does not work.** `DESC` implies
`NULLS FIRST` in Postgres, while the query orders `DESC NULLS LAST`; the index's
ordering therefore does not satisfy the query's `ORDER BY`, so the planner
cannot use it to skip the sort and falls back to the same scan-and-sort plan.
It buys nothing and costs 1.4 MB / 5.6 MB / 27 MB at 50k / 200k / 1M rows
(~10% of the table), plus write amplification on every member update.

Adding the null-ordering that the query actually asks for fixes it:

| rows | plan with `(exited, joined_ledger DESC NULLS LAST) WHERE joined_ledger IS NOT NULL` | median | index size | build time |
|---|---|---|---|---|
| 50,000 | Index Scan (50 rows) | **0.114 ms** | 1.4 MB | 65 ms |
| 200,000 | Index Scan (50 rows) | **0.10 ms** | 5.6 MB | 234 ms |
| 1,000,000 | Index Scan (50 rows) | **0.151 ms** | 27 MB | 2.4 s |

That is ~200× faster at 50k rows and ~2,000× at 1M, because the index returns
the first 50 live rows in order and the sort disappears entirely.

The existing `members_active_idx (address) WHERE exited = false` does **not**
help this query: its leading column is `address`, not `joined_ledger`, so it
cannot supply the requested order. It is there for `/api/stats`' active-member
count, and should stay.

## Recommendation: ship the corrected index, as a follow-up migration

The measurement supports an index — but the one named in the issue does not
help, and shipping it would add write cost for no read benefit. Ship the
corrected form instead, as its own numbered migration (not in this
documentation change):

```sql
-- 0022_members_join_order_idx.sql
CREATE INDEX IF NOT EXISTS members_join_order_idx
    ON members (exited, joined_ledger DESC NULLS LAST)
 WHERE joined_ledger IS NOT NULL;
```

`exited` first lets the planner satisfy `WHERE exited = false` from the index;
the partial predicate keeps phantom rows (issue #14) out of it; `DESC NULLS
LAST` matches the query exactly. With this in place the `ORDER BY` is free and
the plan is a 50-row index scan at every measured scale.

At the current scale this is an optimisation, not a fix: `/api/members` is
wrapped in the short-lived read-through cache, so a 7–23 ms scan at testnet /
small-mainnet membership is not user-visible. Until the migration ships, the
correct plan is to leave the schema alone.

### Revisit threshold

Add `members_join_order_idx` when **any** of:

- live (`exited = false`) membership exceeds **~50,000 rows** — uncached
  execution crosses ~20 ms there and ~110 ms at 200k, per the table above, or
- `/api/members` p95 latency on a cache miss exceeds **~20 ms**, or
- `pg_total_relation_size('members')` exceeds **~15 MB**.

Either way, do not add the issue's `(exited, joined_ledger DESC)` form: the
`NULLS LAST` ordering is the whole point of the index.

Check with:

```sql
SELECT count(*) FILTER (WHERE exited = false AND joined_ledger IS NOT NULL) AS live,
       pg_size_pretty(pg_total_relation_size('members')) AS total
  FROM members;
```

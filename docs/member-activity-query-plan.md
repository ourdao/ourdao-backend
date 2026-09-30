# Query plan: `GET /api/members/:address/activity`

Recorded for issue #193 when the optional `?symbol=` filter was added. The
question was whether narrowing by symbol changes which index the planner
picks, and whether a supporting index is warranted.

## Setup

- Postgres 17 (embedded, default configuration), `src/db/schema.sql` applied
  to an empty database.
- `events` seeded with 300 000 rows (88 MB with indexes) over 2 000 member
  addresses and the full symbol catalog, in a round-robin so every address has
  about 150 events across all kinds and about 16 of any one kind.
- Queries are exactly the route's SQL with `LIMIT 50`, run after
  `VACUUM ANALYZE`; every run was warm (`shared hit` only).

The seeding script is not committed; the shape is what matters and is easy
to reproduce from the numbers above.

## Unfiltered default (`symbol = ANY($1) AND data @> to_jsonb($2::text)`)

```
Limit  (cost=120.95..121.00 rows=23 width=198) (actual time=0.292..0.298 rows=50.00 loops=1)
  Buffers: shared hit=153
  ->  Sort  (cost=120.95..121.00 rows=23 width=198) (actual time=0.291..0.294 rows=50.00 loops=1)
        Sort Key: ledger DESC, id DESC
        Sort Method: top-N heapsort  Memory: 51kB
        Buffers: shared hit=153
        ->  Bitmap Heap Scan on events  (cost=13.00..120.42 rows=23 width=198) (actual time=0.045..0.256 rows=133.00 loops=1)
              Recheck Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
              Filter: (symbol = ANY ('{joined,exited,claimed,staked,unstaked,name_reg,loan_req,loan_edit,loan_vote,loan_appr,loan_rpy,loan_dflt,loan_exp,tre_vote,tre_prop}'::text[]))
              Rows Removed by Filter: 17
              Heap Blocks: exact=150
              Buffers: shared hit=153
              ->  Bitmap Index Scan on events_data_gin_idx  (cost=0.00..12.95 rows=28 width=0) (actual time=0.021..0.021 rows=150.00 loops=1)
                    Index Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
                    Index Searches: 1
                    Buffers: shared hit=3
Planning:
  Buffers: shared hit=61
Planning Time: 0.258 ms
Execution Time: 0.317 ms
```

## Filtered (`?symbol=loan_vote`)

```
Limit  (cost=120.32..120.33 rows=2 width=198) (actual time=0.247..0.250 rows=16.00 loops=1)
  Buffers: shared hit=153
  ->  Sort  (cost=120.32..120.33 rows=2 width=198) (actual time=0.247..0.248 rows=16.00 loops=1)
        Sort Key: ledger DESC, id DESC
        Sort Method: quicksort  Memory: 29kB
        Buffers: shared hit=153
        ->  Bitmap Heap Scan on events  (cost=12.95..120.31 rows=2 width=198) (actual time=0.054..0.239 rows=16.00 loops=1)
              Recheck Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
              Filter: (symbol = 'loan_vote'::text)
              Rows Removed by Filter: 134
              Heap Blocks: exact=150
              Buffers: shared hit=153
              ->  Bitmap Index Scan on events_data_gin_idx  (cost=0.00..12.95 rows=28 width=0) (actual time=0.022..0.022 rows=150.00 loops=1)
                    Index Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
                    Index Searches: 1
                    Buffers: shared hit=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.177 ms
Execution Time: 0.268 ms
```

## Filtered with a `?before=` cursor

```
Limit  (cost=120.39..120.40 rows=1 width=198) (actual time=0.241..0.243 rows=8.00 loops=1)
  Buffers: shared hit=153
  ->  Sort  (cost=120.39..120.40 rows=1 width=198) (actual time=0.240..0.241 rows=8.00 loops=1)
        Sort Key: ledger DESC, id DESC
        Sort Method: quicksort  Memory: 27kB
        Buffers: shared hit=153
        ->  Bitmap Heap Scan on events  (cost=12.95..120.38 rows=1 width=198) (actual time=0.052..0.235 rows=8.00 loops=1)
              Recheck Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
              Filter: ((ledger < '1050000'::bigint) AND (symbol = 'loan_vote'::text))
              Rows Removed by Filter: 142
              Heap Blocks: exact=150
              Buffers: shared hit=153
              ->  Bitmap Index Scan on events_data_gin_idx  (cost=0.00..12.95 rows=28 width=0) (actual time=0.021..0.021 rows=150.00 loops=1)
                    Index Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
                    Index Searches: 1
                    Buffers: shared hit=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.140 ms
Execution Time: 0.258 ms
```

## Reading the plans

- In every shape the planner drives the query from `events_data_gin_idx`
  (the `jsonb_path_ops` GIN index on `data`): the address containment is
  the selective predicate, about 150 rows out of 300 000. `symbol`, whether
  `= ANY(...)` or a single equality, is applied as a heap filter on those
  rows, and so is the cursor bound.
- `events_symbol_idx` is never chosen. A symbol matches tens of thousands
  of rows; the GIN lookup is two orders of magnitude more selective, and
  the extra filter costs microseconds. That is the "which index wins"
  question the issue raised, answered: the GIN index, in both shapes.
- The symbol filter therefore does not make the plan cheaper (about 0.27 ms
  versus 0.32 ms here) so much as the *result* smaller: a client that wants
  one kind no longer pages through 150 rows to find 16.

## Candidate index

A composite `(symbol, ledger DESC, id DESC)` btree was added to the same
table and the filtered query re-planned:

```
Limit  (cost=120.32..120.33 rows=2 width=198) (actual time=0.251..0.253 rows=16.00 loops=1)
  Buffers: shared hit=153
  ->  Sort  (cost=120.32..120.33 rows=2 width=198) (actual time=0.250..0.251 rows=16.00 loops=1)
        Sort Key: ledger DESC, id DESC
        Sort Method: quicksort  Memory: 29kB
        Buffers: shared hit=153
        ->  Bitmap Heap Scan on events  (cost=12.95..120.31 rows=2 width=198) (actual time=0.055..0.242 rows=16.00 loops=1)
              Recheck Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
              Filter: (symbol = 'loan_vote'::text)
              Rows Removed by Filter: 134
              Heap Blocks: exact=150
              Buffers: shared hit=153
              ->  Bitmap Index Scan on events_data_gin_idx  (cost=0.00..12.95 rows=28 width=0) (actual time=0.022..0.022 rows=150.00 loops=1)
                    Index Cond: (data @> to_jsonb('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA42'::text))
                    Index Searches: 1
                    Buffers: shared hit=3
Planning:
  Buffers: shared hit=60 read=1
Planning Time: 0.353 ms
Execution Time: 0.272 ms
```

The planner ignores it — the address predicate still dominates — so it
would cost writes and space on the append-only log for nothing. **No
migration is added.** The situation to revisit is a member with tens of
thousands of events of one kind, where the heap filter over the GIN result
would stop being negligible; at that point an index on
`(symbol, (data->>...))` per address field would be the candidate, not a
plain symbol/ledger btree.

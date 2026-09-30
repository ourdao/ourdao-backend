# Reorg recovery runbook

Operational guide for diagnosing and resolving an indexer reorg alarm. Written for the engineer paged at 3am: it explains how the indexer detects a ledger discontinuity, what state it left behind, and the exact steps — and SQL — to verify and recover.

> **TL;DR.** A reorg alarm halts the indexer on purpose. It never rolls anything back automatically: derived tables are stopped but **not corrupted** (they describe a prefix of the chain the indexer verified before the halt). Confirm the halt is genuine, let the chain settle, then run `npm run reindex` to rebuild every derived table from the raw `events` log and restart the worker. Section 6 is the full procedure.

## Table of contents

- [1. Background: how the indexer tracks its position](#1-background-how-the-indexer-tracks-its-position)
  - [The `indexer_cursor` row](#the-indexer_cursor-row)
  - [`last_ledger` vs `observed_tip_ledger` — why two numbers](#last_ledger-vs-observed_tip_ledger--why-two-numbers)
- [2. How reorg detection works](#2-how-reorg-detection-works)
  - [Check 1 — coarse rewind (sequence went backwards)](#check-1--coarse-rewind-sequence-went-backwards)
  - [Check 2 — same-height fork (hash changed)](#check-2--same-height-fork-hash-changed)
  - [Check 3 — per-event continuity (event from below the fold point)](#check-3--per-event-continuity-event-from-below-the-fold-point)
  - [What happens when a check fires](#what-happens-when-a-check-fires)
- [3. What SQL runs during detection and recovery](#3-what-sql-runs-during-detection-and-recovery)
- [4. Diagnostic queries: inspecting cursor state](#4-diagnostic-queries-inspecting-cursor-state)
- [5. Triage: is it a real reorg?](#5-triage-is-it-a-real-reorg)
- [6. Recovery procedure](#6-recovery-procedure)
- [7. What cannot be recovered](#7-what-cannot-be-recovered)
- [8. False alarms and near-miss alarms](#8-false-alarms-and-near-miss-alarms)
- [9. FAQ](#9-faq)
- [10. Related documentation](#10-related-documentation)

---

## 1. Background: how the indexer tracks its position

The indexer polls the Soroban RPC's `getEvents` for the configured contract and folds each event into Postgres: the raw event first into the append-only `events` log, then its derived side effects into `members`, `loan_proposals`, `loans`, `treasury_proposals`, `notifications`, `interest_distributions`, and `documents` — raw row and fold always in one transaction (`src/indexer/poller.ts`). Resume position lives in a single row in `indexer_cursor`.

### The `indexer_cursor` row

One row, `id = 1` (enforced by a CHECK constraint). Created by `src/db/schema.sql`, altered by `src/db/migrations/0009_indexer_cursor_observed_tip.sql`.

| Column | Type | Written by `saveCursor` as | Meaning |
|---|---|---|---|
| `id` | `SMALLINT` | always `1` | Singleton marker |
| `paging_token` | `TEXT` | the last page's final event `id` (falls back to the RPC's `cursor`) | `getEvents` resume token — where the next poll resumes |
| `last_ledger` | `BIGINT` | the highest ledger whose events were **actually folded** | The fold point. Drives the reorg continuity checks. Never advances past un-folded history (issue #45) |
| `last_ledger_hash` | `TEXT` | the hash of `last_ledger` **itself**, fetched by sequence from the RPC | Pins *which* history was folded to at that height. Drives the same-height fork check (issues #127, #128) |
| `observed_tip_ledger` | `BIGINT` | the RPC's `latestLedger` as of the last page | Freshness signal only (`/ready`, `/api/stats`). **Never** used in the reorg checks |
| `contract_id` | `TEXT` | the `CONTRACT_ID` the cursor was advanced for | A cursor belonging to a different contract is discarded (cold start) rather than resumed |
| `updated_at` | `TIMESTAMPTZ` | `now()` on every save, and touched on idle polls | Freshness signal for `/ready` (`INDEXER_STALE_AFTER_MS`, default 2 min) |

### `last_ledger` vs `observed_tip_ledger` — why two numbers

`last_ledger` answers *"how far has the indexer folded?"*; `observed_tip_ledger` answers *"how far along is the chain, as the RPC last reported?"*. An early version fed the second into the first: during catch-up a single **empty** `getEvents` page (no events for the contract, but the chain still advanced) jumped `last_ledger` to the chain tip. The next real page — full of legitimate, but historically earlier, events — then sat *below* the cursor and tripped the continuity check. A false alarm, every catch-up (issue #45).

Since then the tip lives only in `observed_tip_ledger`, and `last_ledger` moves only when a page with events folds. Keep the distinction in mind throughout: `last_ledger` is history the indexer vouches for; `observed_tip_ledger` is hearsay from the RPC.

---

## 2. How reorg detection works

Stellar's consensus gives fast finality, so a deep reorg is unlikely — but the indexer *notices* one rather than silently folding events from a diverged history (issue #23). Three independent checks run on every poll iteration of `fetchOnce` (`src/indexer/poller.ts`):

### Check 1 — coarse rewind (sequence went backwards)

Before fetching any page, the poller calls `getLatestLedger` and compares:

```
RPC latest ledger < cursor.last_ledger  →  halt
```

Log line: `RPC latest ledger N is below the last folded ledger M — the chain rewound past applied history`.

Catches the obvious case: the chain's tip sequence dropped below history already folded. Since a dropped sequence means ledgers were discarded, anything folded past the new tip may no longer exist on-chain.

### Check 2 — same-height fork (hash changed)

The sequence-only check above is blind to a fork that replaces history *without* lowering the sequence number. So the poller also asks the RPC for the hash of exactly `cursor.last_ledger` (`getLedgerHash`, `src/stellar/rpc.ts`) and compares:

```
RPC hash of sequence N ≠ cursor.last_ledger_hash  →  halt
```

Log line: `ledger N's hash changed from X to Y — history diverged at the same height`.

This works because `last_ledger_hash` records the hash of the ledger *folded to itself* (issue #127), not the tip's hash: the stored pair `(last_ledger, last_ledger_hash)` names a specific point in a specific history, and the comparison re-proves the point still exists with the same identity.

**`getLedgerHash` resolving to `null` is not an alarm.** The RPC throws (rather than answering) for a sequence pruned from its retention window, and a transient network error is equally unanswerable. `null` means *unverifiable, not diverged* — the check is skipped for that poll. Letting a hiccup reject here would wedge `fetchOnce` in permanent retry over history that may already be safely folded and committed.

### Check 3 — per-event continuity (event from below the fold point)

Finally, as each page is ingested (in both the whole-page path `ingestPage` and the per-event quarantine path `ingestEventQuarantined`), every event's ledger is compared against the cursor:

```
event.ledger < cursor.last_ledger  →  halt
```

Log line: `event <id> is from ledger N, below the last folded ledger M`.

`getEvents` returns events in ascending ledger order and the poller resumes from its paging token, so an event from an already-folded ledger can only mean the RPC is serving a *different* history than the one folded.

### What happens when a check fires

The check throws `ReorgDetectedError` (`src/indexer/poller.ts`). In `runIndexer`'s poll loop this is special-cased — **never retried, never quarantined** (retrying would fold events from the diverged history):

```
[indexer] LEDGER DISCONTINUITY DETECTED — halting the indexer. <detail>
[indexer] Recovery: confirm the true chain state, then run `npm run reindex` to rebuild
          the derived tables from the raw events log. See README "Reorg detection".
```

Before the error propagates, `runIndexer` records the halt in `reorg_halts` (issue #191): the contract, the cursor's last folded ledger and hash, the detail above, and a timestamp. Then the worker process exits non-zero (`[indexer] fatal:` in `src/worker.ts`).

A container supervisor restarts it — and the restarted worker refuses to start: `runIndexer` checks for an uncleared `reorg_halts` row before touching the RPC and exits with `[indexer] REFUSING TO RESUME`. This is deliberate. The three checks alone are not enough to keep a restart from resuming: once the chain advances past the old `last_ledger`, the coarse rewind check passes again, and if the RPC has since pruned that ledger the hash check reports "unverifiable" rather than "fork" — so an automatic restart could quietly continue from diverged history. The persisted record closes that gap. It is cleared by `npm run reindex` (section 6) or, for a false alarm, `npm run reorg:clear` (section 8).

While the record is uncleared it is visible over the API, not only in logs: `GET /ready` returns `503` with `reason: reorg_detected` and a `reorg` object (`detectedAt`, `contractId`, `lastLedger`, `detail`), distinct from `indexer_stale`; `GET /api/stats` reports `reorgDetected: true` and the same details in `reorgHalt`.

**Nothing is rolled back automatically.** There is no rollback SQL executed at halt time. The raw `events` log and every derived table are left exactly as committed. This is deliberate: the folded state still describes a consistent prefix of *some* history, and `npm run reindex` is the rollback — it rebuilds every derived table from the raw log in one transaction.

---

## 3. What SQL runs during detection and recovery

**At detection time, none.** No rollback SQL runs. The only writes that already happened are the normal ones: each ingested page ran

```sql
BEGIN;
SELECT pg_try_advisory_lock(222298113);  -- REINDEX_LOCK_KEY (0x0d400001), session-level
INSERT INTO events (...) ... ON CONFLICT (id) DO UPDATE SET id = events.id RETURNING folded_at;
-- ... applyEvent: derived-table upserts for each event ...
UPDATE events SET folded_at = now() WHERE id = $1;
COMMIT;
```

per event (batched per page in one transaction on the fast path), plus the cursor advance:

```sql
INSERT INTO indexer_cursor (id, paging_token, last_ledger, last_ledger_hash, observed_tip_ledger, contract_id, updated_at)
VALUES (1, $1, $2, $3, $4, $5, now())
ON CONFLICT (id) DO UPDATE SET paging_token = $1, last_ledger = $2, last_ledger_hash = $3,
  observed_tip_ledger = $4, contract_id = $5, updated_at = now();
```

The halt itself is a thrown exception. The point of "detection only": history the indexer folded is presumed good until proven otherwise, and proving otherwise is exactly what section 6 does.

**Recovery runs exactly one rebuild — `npm run reindex` (`src/indexer/reindex.ts`).** Inside a single transaction it:

```sql
BEGIN;
SELECT pg_try_advisory_lock(222298113);            -- same lock: cannot race the worker
SET LOCAL statement_timeout = 0;                   -- a full rebuild outlives the pool default
SELECT set_config('application_name', 'ourdao-reindex', true);  -- visible in pg_stat_activity
SELECT event_id, address FROM notifications WHERE read = true AND event_id IS NOT NULL;
                                                   -- user read-states preserved across rebuild
TRUNCATE members, loan_proposals, loans, treasury_proposals,
         notifications, interest_distributions, documents RESTART IDENTITY;
UPDATE dao_totals SET interest_collected = 0, principal_lent = 0,
                      principal_repaid = 0, value_defaulted = 0, updated_at = now() WHERE id = 1;
-- keyset-paginated replay over the raw log, in (ledger, id) order:
--   SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
--     FROM events
--    WHERE ledger > $1 OR (ledger = $1 AND id > $2)
--    ORDER BY ledger ASC, id ASC
--    LIMIT 1000;
-- ... applyEvent re-folds each row into the truncated tables ...
UPDATE failed_events SET resolved_at = now() WHERE resolved_at IS NULL;
COMMIT;
```

Notes:

- `failed_events` and `quarantine_state` are **not** truncated — they are bookkeeping, not derived state. A successful reindex marks every outstanding quarantine record `resolved_at = now()` (issue #168): the rebuild just re-applied the entire log without error, which *is* the proof the events now fold.
- The rebuild produces state byte-identical to the incremental fold (asserted by `test/indexer-totals-reindex.test.ts`), which is what makes the raw log authoritative and reindexing a real recovery mechanism.
- The transaction is all-or-nothing: a mid-rebuild crash rolls back to the pre-rebuild state, and the log is untouched either way.

---

## 4. Diagnostic queries: inspecting cursor state

Run these against the production database read-only while triaging. `psql "$DATABASE_URL"`.

**The cursor row — always start here:**

```sql
SELECT id, paging_token, last_ledger, last_ledger_hash,
       observed_tip_ledger, contract_id, updated_at,
       round(extract(epoch FROM (now() - updated_at))) AS seconds_stale
  FROM indexer_cursor;
```

Reading it:

- `seconds_stale` under ~120 (default `INDEXER_STALE_AFTER_MS`) and a healthy gap `observed_tip_ledger - last_ledger` (roughly under 20–40 ledgers) → the indexer is alive and caught up; a reorg alarm is probably not your current problem.
- `observed_tip_ledger < last_ledger` → matches a **Check 1** halt; the RPC (or the network) reported a tip below folded history. Proceed to triage (section 5).
- `last_ledger` and `observed_tip_ledger` fine, but the worker still halting → suspect a **Check 2** or **Check 3** trigger; grab the halt line from the worker logs for the specific ledger/event it names.

**What the fold actually covered — highest folded ledger and its event ledger range:**

```sql
SELECT max(ledger) AS max_event_ledger, min(ledger) AS min_event_ledger, count(*) AS events
  FROM events;
```

**The ledger the cursor pins, as the RPC reports it today** (substitute `:last_ledger`; requires the RPC's `/getLedgers` — this is the same query `getLedgerHash` performs):

```bash
curl -s -X POST "$SOROBAN_RPC_URL" -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1,
  "method": "getLedgers",
  "params": { "startLedger": 5700000, "pagination": { "limit": 1 } }
}'
```

Compare `result.ledgers[0].hash` with the `last_ledger_hash` from the cursor query. Equal → that height's history is unchanged; unequal → **Check 2** fired correctly; error/absent → pruned or unreachable, unverifiable.

**Halt evidence in the raw log — events at or below the fold point that arrived after it:**

```sql
SELECT id, ledger, closed_at, symbol, tx_hash, folded_at, created_at
  FROM events
 WHERE ledger <= (SELECT last_ledger FROM indexer_cursor WHERE id = 1)
 ORDER BY ledger DESC, id DESC
 LIMIT 20;
```

`created_at` (insert time) vs `closed_at` (chain time) tells you whether a suspicious row is freshly fetched re-delivery or long-standing history.

**Highest contiguous folded frontier — how far the fold actually got:**

```sql
SELECT max(ledger) AS folded_through
  FROM events
 WHERE folded_at IS NOT NULL;
```

`folded_through` materially below `last_ledger` is normal after a quarantine (some events intentionally unfolded); it matters for judging what a rebuild will replay.

**Live health view (no psql required):** `GET /ready` and `GET /api/stats` expose the same numbers — `lastIndexedLedger` (= `last_ledger`), `observedTipLedger`, `ledgersBehind`, `estimatedLagSeconds`, `quarantinedEvents`. Handy for the incident channel; the SQL above is the ground truth.

---

## 5. Triage: is it a real reorg?

The alarm fires when the RPC's story stopped matching ours. Before rebuilding, spend five minutes deciding *whose* story is wrong — the RPC's, ours, or nobody's (a false alarm):

1. **Read the exact halt line** in the worker logs. It names the check (section 2) and the ledger/event.
2. **Query the RPC independently.** `curl` the RPC's `getLatestLedger` and, for the halted sequence, `getLedgerHash` as shown in section 4. Compare against the stored cursor pair from the diagnostic query.
3. **Cross-check the network.** Public dashboard (e.g. stellarbeat.io) or a *second* RPC endpoint: does the network's current history at the halted sequence match ours? If a second independent source agrees with our `last_ledger_hash`, the first RPC is the outlier, not the chain.
4. **Check for a Stellar protocol/network incident.** If the network actually reorganized, it is announced loudly; it changes your communication, not your recovery steps.
5. **Check recent operator activity** against the failure mode in section 8: a redeployed RPC provider, a restored-from-backup database, or someone repointing `DATABASE_URL` can each mimic a reorg without one happening.
6. **Decide:**

| Finding | Verdict | Action |
|---|---|---|
| Multiple sources agree our hash is stale; chain history genuinely diverged | **Real reorg** | Full procedure, section 6 |
| Only our configured RPC disagrees; second RPC matches our cursor | RPC fault / roll-back of its own state | Procedure, section 6 — but also plan to fix or replace the RPC endpoint; the rebuild just re-reads the same bad source for the *tail* otherwise |
| RPC could not answer at all (`null` hash path, timeouts) | Unverifiable, not divergent | Don't rebuild yet: wait for the RPC to recover and let the checks re-run; if the halt can't clear, restart the worker once to confirm the halt reproduces before treating it as real |
| Nothing else explains it and no independent source confirms divergence | Suspected false alarm | Do **not** bypass checks casually. If you must resume, go through section 8's restart sequence, which re-validates the cursor before folding anything |

---

## 6. Recovery procedure

Prerequisites: shell access to the deployment, `DATABASE_URL`, the worker stopped or known to be halted, and (from triage) reasonable confidence the alarm reflects real divergence or an RPC fault.

**Step 1 — Stop the worker.**

```bash
# however the deployment runs it, e.g.:
docker compose stop worker          # or: kubectl scale deploy/ourdao-worker --replicas=0
```

The worker may already have exited non-zero from the halt. Ensure it cannot restart mid-recovery — it must not fold events while you work. (All fold paths take the `REINDEX_LOCK_KEY` advisory lock, so a live worker would make step 4 fail fast rather than race, but don't rely on that: stop it.)

**Step 2 — Snapshot the evidence and the state.**

```bash
psql "$DATABASE_URL" -c "SELECT * FROM indexer_cursor;" > reorg-cursor-$(date -u +%Y%m%dT%H%M%S).txt
psql "$DATABASE_URL" -c "SELECT max(ledger), count(*) FROM events;" >> reorg-cursor-$(date -u +%Y%m%dT%H%M%S).txt
psql "$DATABASE_URL" -c "SELECT * FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC;" >> reorg-cursor-$(date -u +%Y%m%dT%H%M%S).txt
```

The `reorg_halts` row survives the worker's exit and its log rotation; `GET /ready` shows the same fields if you have no shell.

Keep the halt log lines too. Cheap, and every post-mortem wants them.

**Step 3 — Let the chain settle (real reorg only).**

Do not rebuild while the network itself is mid-reorganization, or the fresh rebuild may fold the *losing* history. Wait until the tip is advancing normally again and your chosen RPC serves a stable hash for the halted sequence (section 4's curl, twice, a few minutes apart, same answer).

**Step 4 — Rebuild derived tables from the raw log.**

```bash
npm run reindex          # node dist/indexer/reindex.js in the container
```

What it does is spelled out in section 3: truncate the derived tables, zero `dao_totals`, replay the entire `events` log in `(ledger, id)` order inside one transaction, restore notification read-states, mark outstanding quarantine records resolved, and clear the `reorg_halts` record (`cleared_by = 'reindex'`) so the worker may start again. Do not clear the record by hand and restart the worker without rebuilding — that is precisely the resume-past-divergence the record exists to prevent. Progress logs periodically (count, %, rate, ETA); at 10k events expect seconds.

If it exits with `Cannot acquire reindex advisory lock (0x0d400001)` something else holds the lock — a live worker or another reindex. Stop that first; the lock is the guard that keeps a rebuild from racing a fold.

The raw `events` log is **never** modified or truncated by any of this — it is the audit trail and the thing you are rebuilding *from*.

**Step 5 — Verify the rebuild.**

```sql
SELECT max(ledger) AS folded_through, count(*) AS events, count(*) - count(folded_at) AS unfolded
  FROM events;

-- spot-check: totals recomputed from scratch
SELECT * FROM dao_totals;

-- derived tables repopulated, counts sane against the event mix
SELECT 'members' t, count(*) FROM members
UNION ALL SELECT 'loan_proposals', count(*) FROM loan_proposals
UNION ALL SELECT 'loans', count(*) FROM loans
UNION ALL SELECT 'treasury_proposals', count(*) FROM treasury_proposals
UNION ALL SELECT 'notifications', count(*) FROM notifications
UNION ALL SELECT 'interest_distributions', count(*) FROM interest_distributions
UNION ALL SELECT 'documents', count(*) FROM documents
ORDER BY 1;
```

Expect `unfolded = 0` and every table non-empty (for an active contract). Cross-check one figure — e.g. `totalMembers` from the counts against `GET /api/stats` once the API is back — against an independent source if you have one.

**Step 6 — Restart the worker and confirm it resumes cleanly.**

```bash
docker compose start worker       # or: kubectl scale deploy/ourdao-worker --replicas=1
```

Then watch its logs for one normal poll cycle:

- Good: `[indexer] watching C... on <rpc>`, then either quiet polls or `[indexer] page N: ingested K event(s) up to ledger L`.
- The two reorg checks re-run automatically on the first poll: if the chain/RPC is still inconsistent, it halts again rather than folding — back to triage.
- The cursor advances only as new pages fold; it does **not** jump to the tip (issue #45), so a few minutes of catch-up behind `observedTipLedger` is expected and healthy.

**Step 7 — Close the loop.**

- Confirm `GET /ready` returns `200` (the `reorg_detected` reason is gone) and `GET /api/stats` shows `reorgDetected: false` and `ledgersBehind` shrinking to the normal few.
- If a frontend or consumers noticed the halt, send the all-clear with the incident window.
- File the post-mortem: what diverged, how triage resolved it, total downtime. Attach the snapshot from step 2.

---

## 7. What cannot be recovered

- **Events orphaned *and* pruned from the RPC.** Soroban RPCs retain only ~24h of event history. If the diverged history emitted events that never made it into our `events` log before the RPC discarded them, they are gone for good — `reindex` rebuilds from whatever the log holds, and the log can only hold what some poll fetched. This is why the runbook's first instinct is *snapshot and triage*, not *nuke and rebuild*: the log is the irreducible record.
- **Set `START_LEDGER` deliberately on first deploy** (to the contract's deploy ledger) so the log captures everything from genesis; events older than the RPC window at first-boot time are permanently unavailable.

---

## 8. False alarms and near-miss alarms

A halt that triage (section 5) shows to be an RPC fault rather than a real divergence — the RPC briefly served a wrong hash for `last_ledger` and now agrees with a second RPC — still leaves an uncleared `reorg_halts` record, and the worker will not start until it is cleared. Acknowledge it without rebuilding:

```bash
npm run reorg:clear          # node dist/indexer/clear-reorg.js in the container
```

It marks every open record `cleared_by = 'operator'` and keeps it as history. Only do this once you are confident nothing was folded from a diverged history; when in doubt, `npm run reindex` is always safe and also clears the record.

Known ways the checks can fire without a chain reorg, and what each looks like:

- **RPC provider swapped/restored state** (Check 2). A provider that restored an old snapshot serves old hashes for recent sequences. Symptom: hash mismatch on the halted sequence, second RPC disagrees with the first. Fix the endpoint *and* run the rebuild — derived state must match whatever source you keep polling.
- **Stale RPC behind load balancing** (Check 1). One backend of an RPC service serving an older tip. `observed_tip_ledger < last_ledger` at halt, tip fine from a second query. Retry/restart usually clears it; if it recurs, the provider's LB is sticking you to a lagging node.
- **Database restored from a backup while the chain ran on** (Check 1). The restored cursor's `last_ledger` sits ahead of what its own `events` table actually contains. Section 4's "highest contiguous folded frontier" query exposes it (`folded_through` far below `last_ledger`). Recovery is the standard rebuild — the log replays whatever survived — plus fixing your backup/restore ordering.
- **The historical false-positive class (issue #45) — now fixed.** Empty pages no longer advance `last_ledger`, so catch-up cannot self-trip the continuity check. If you *suspect* this class: the signature is a halt during catch-up with `observed_tip_ledger - last_ledger` small and negative *before* any real divergence, and the alarm disappears after an ordinary restart. Report it — the invariant `last_ledger` only moves on folded pages is test-pinned (`test/indexer-quarantine-cursor.test.ts`, "last_ledger vs observed_tip_ledger").

**If triage concludes "false alarm" but you still need the worker running:** do not disable the checks. Restart the worker once — the checks re-run and, if the condition truly cleared, it resumes normally. A halt that reproduces on restart is, by construction, real. If it reproduces *and* triage still says false alarm, file an issue with the halt line, the cursor snapshot, and the RPC responses from section 4; the checks are cheap to adjust with evidence, and expensive to have silenced on a hunch.

---

## 9. FAQ

**Why doesn't the indexer just roll back automatically?**
Because a rollback needs to know which history is true, and at halt time the indexer has exactly one vote (its RPC's). Halting loudly converts a silent-corruption risk into a bounded outage with a human in the loop. The rebuild-from-log path is the rollback, and it's always available because the raw log is append-only and never pruned.

**Is derived data wrong between the halt and the rebuild?**
It is *frozen*, not wrong. It describes a consistent prefix of the history the indexer had been following. After a genuine reorg, the tail of that prefix may no longer match the chain — which is what the rebuild fixes. The API keeps serving during this window; consumers see pre-reorg values until recovery completes.

**Does recovery lose events emitted during the outage?**
No. Once the worker restarts after the rebuild, it resumes from its paging token and drains the backlog (bounded by `DRAIN_MAX_PAGES`/`DRAIN_MAX_MS` per poll). Only events pruned from the RPC before any poll fetched them are lost (section 7).

**Can I reindex while the API is serving?**
Yes. The API only reads. The rebuild's TRUNCATE+replay is one transaction, so readers see either the old derived state or the new one — never a half-built table. Expect the numbers you read mid-rebuild to be pre-rebuild; that's the transaction boundary doing its job.

**The reindex failed halfway. Is state now broken?**
No. It's one transaction; a failure rolls back completely to the pre-rebuild state. Fix the cause (most commonly the advisory lock — see step 4) and run it again.

**How do I test any of this?**
Everything above is exercised by the suite: continuity and hash-change detection (`test/indexer-ledger-hash-reorg.test.ts`, `test/indexer-totals-reindex.test.ts`), the `last_ledger`/`observed_tip_ledger` split (`test/indexer-quarantine-cursor.test.ts`), and rebuild equivalence (`test/indexer-totals-reindex.test.ts`). Reproduce locally with `docker compose up -d` + `TEST_DATABASE_URL=... npm test`.

---

## 10. Related documentation

- **README — [Reorg detection](../README.md#reorg-detection)** — the short version of section 2, with quarantine and worker-serialization context.
- **`docs/DEPLOYMENT.md` — Operations** — health probes, "what *behind* looks like" (the non-reorg staleness playbook), and the log lines to monitor.
- **`docs/events-storage.md`** — growth model and index review for the raw `events` log that all of this depends on.
- **`src/indexer/poller.ts`** — the checks themselves (`ReorgDetectedError`, `fetchOnce`, `runIndexer`); every behavior in this document traces to a comment there.
- **`src/indexer/reindex.ts`** — the rebuild; `npm run reindex`.
- **`src/indexer/replay.ts`** — targeted re-fold of quarantined events (`npm run replay-failed`) — for handler bugs, not reorgs.
- **`src/db/schema.sql` / `src/db/migrations/0009_indexer_cursor_observed_tip.sql`** — cursor shape and the observed-tip column's history.

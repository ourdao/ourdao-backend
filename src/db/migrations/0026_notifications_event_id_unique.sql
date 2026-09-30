-- compat: breaking (adds UNIQUE(event_id, address) to notifications: a release that inserts a duplicate event notification without ON CONFLICT now errors instead of silently writing a second row — see the paired handlers.ts change)
-- Issue #271: notifications generated from `loan_req` / `treasury_prop` were
-- inserted with no conflict handling, and the only index on (event_id, address)
-- was non-unique. Replaying an event — which the indexer does deliberately
-- after a reorg, and which any worker restart can trigger — therefore wrote a
-- second identical notification. The member's inbox showed the same contract
-- action twice, and each replay added another copy.
--
-- Two changes, both required:
--   1. Fold any duplicates that already exist, keeping the oldest row per
--      (event_id, address) so the read state a member already set survives.
--      Rows with a NULL event_id are pre-#52 legacy rows and are left alone:
--      NULL never conflicts in a UNIQUE index, so they cannot dedupe against
--      each other and deleting them would lose notifications.
--   2. Replace the non-unique index with a UNIQUE one, so the guarantee is
--      enforced by the database rather than by the insert path remembering.

-- 1. Fold existing duplicates. `id` is BIGSERIAL, so the lowest id is the
--    first time the action was recorded.
DELETE FROM notifications n
 USING notifications keep
 WHERE n.event_id IS NOT NULL
   AND n.event_id = keep.event_id
   AND n.address  = keep.address
   AND n.id > keep.id;

-- 2. The unique index is what makes `ON CONFLICT (event_id, address)` in
--    handlers.ts possible; the non-unique index is subsumed by it.
DROP INDEX IF EXISTS notifications_event_id_address_idx;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_id_address_uniq
  ON notifications (event_id, address);

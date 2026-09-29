-- compat: breaking (drops and recreates auth_nonces keyed on nonce instead of address; a previous release relying on one row per address cannot run against it, and rolling back cannot restore the old table)
-- Migration: Re-key auth_nonces to support multiple outstanding nonces per address (issues #179, #180)
--
-- Prior to this migration, auth_nonces was keyed on (address), so an address could
-- have only one outstanding challenge at a time. This prevented:
-- - Independent sessions on separate devices (issue #180)
-- - Per-address rate limiting (issue #180)
-- - Scoping a nonce to a specific action (issue #180)
--
-- This migration re-keys on (nonce) as the primary key with a non-unique index
-- on (address), supporting all of the above. The new schema also enables atomic
-- nonce issuance to close the race condition between SELECT and INSERT (issue #179).
--
-- Steps:
-- 1. Rename the old table to _old
-- 2. Recreate with new schema
-- 3. Copy any unexpired rows from _old
-- 4. Drop _old

-- Renumbered from 0022 (it collided with 0022_failed_events_uniqueness.sql,
-- which made the loader refuse to boot). On an existing database schema.sql
-- runs first and has already created auth_nonces_expires_at_idx /
-- auth_nonces_address_idx on the *old* table, so drop them before reusing
-- the names on the new one.
DROP INDEX IF EXISTS auth_nonces_expires_at_idx;
DROP INDEX IF EXISTS auth_nonces_address_idx;

-- Create new table with nonce as primary key
CREATE TABLE auth_nonces_new (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for cleanup queries (delete expired nonces)
CREATE INDEX auth_nonces_expires_at_idx ON auth_nonces_new (expires_at);

-- Index for address lookups (per-address nonce count, etc.)
CREATE INDEX auth_nonces_address_idx ON auth_nonces_new (address);

-- Copy unexpired nonces from old table to new
INSERT INTO auth_nonces_new (nonce, address, expires_at, created_at)
SELECT nonce, address, expires_at, created_at
FROM auth_nonces
WHERE expires_at > now();

-- Drop old table and rename new one
DROP TABLE auth_nonces;
ALTER TABLE auth_nonces_new RENAME TO auth_nonces;

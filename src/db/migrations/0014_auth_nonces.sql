-- Migration: Add auth_nonces table for shared nonce storage across API instances (issue #66)
-- This table stores short-lived nonces used in the authentication challenge-response flow.
-- Nonces are consumed atomically via DELETE ... WHERE ... AND expires_at > now() RETURNING *

CREATE TABLE auth_nonces (
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  
  -- Unique constraint ensures only one nonce per address at a time
  UNIQUE (address)
);

-- Index to support cleanup of expired nonces
CREATE INDEX idx_auth_nonces_expires_at ON auth_nonces (expires_at);

-- Index to support lookups by nonce (if needed for debugging)
CREATE INDEX idx_auth_nonces_nonce ON auth_nonces (nonce);

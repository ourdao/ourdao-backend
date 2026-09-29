import { Keypair, StrKey, MuxedAccount } from '@stellar/stellar-sdk'
import { randomBytes } from 'crypto'
import type { Pool } from 'pg'

// Authentication failure counters (issue #183)
export const authStats = {
  challengesIssued: 0,
  verificationsSucceeded: 0,
  verificationsFailed: {
    missingHeaders: 0,
    invalidNonce: 0,
    invalidSignature: 0,
    addressMismatch: 0,
    malformedEncoding: 0,
    unsupportedAddressType: 0,
  },
}

// Per-address failure tracking for exponential backoff (issue #184)
interface FailureRecord {
  count: number
  lastFailureAt: number
  nextAllowedAt: number
}

export class AuthFailureTracker {
  private failures = new Map<string, FailureRecord>()
  private readonly BASE_BACKOFF_MS = 1000 // 1 second
  private readonly MAX_BACKOFF_MS = 60000 // 1 minute
  private readonly FAILURE_WINDOW_MS = 300000 // 5 minutes
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor() {
    // Clean up old failure records every minute
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      const staleThreshold = now - this.FAILURE_WINDOW_MS
      for (const [address, record] of this.failures.entries()) {
        if (record.lastFailureAt < staleThreshold) {
          this.failures.delete(address)
        }
      }
    }, 60000)
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /** Check if an authentication attempt is allowed for this address */
  isAllowed(address: string): boolean {
    const record = this.failures.get(address)
    if (!record) return true
    return Date.now() >= record.nextAllowedAt
  }

  /** Get remaining backoff time in milliseconds, or 0 if allowed */
  getRemainingBackoff(address: string): number {
    const record = this.failures.get(address)
    if (!record) return 0
    const remaining = record.nextAllowedAt - Date.now()
    return Math.max(0, remaining)
  }

  /** Record a failed authentication attempt and calculate new backoff */
  recordFailure(address: string): void {
    const now = Date.now()
    const existing = this.failures.get(address)
    
    if (existing && now - existing.lastFailureAt < this.FAILURE_WINDOW_MS) {
      // Within failure window - increment count and increase backoff
      const newCount = existing.count + 1
      // Exponential backoff: 2^(count-1) * BASE_BACKOFF_MS, capped at MAX
      const backoffMs = Math.min(
        Math.pow(2, newCount - 1) * this.BASE_BACKOFF_MS,
        this.MAX_BACKOFF_MS
      )
      this.failures.set(address, {
        count: newCount,
        lastFailureAt: now,
        nextAllowedAt: now + backoffMs,
      })
    } else {
      // First failure or outside window - reset to base backoff
      this.failures.set(address, {
        count: 1,
        lastFailureAt: now,
        nextAllowedAt: now + this.BASE_BACKOFF_MS,
      })
    }
  }

  /** Clear failure record on successful authentication */
  recordSuccess(address: string): void {
    this.failures.delete(address)
  }
}

// Minimal structural subset of the Fastify/Pino logger — just what auth needs
// to log through the request's logger instead of `console.*` (issue #132),
// so `LOG_LEVEL` applies and log lines carry the request correlation id.
export interface AuthLogger {
  debug(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  info(msg: string): void
}

// Typed error for nonce store capacity exceeded (issue #135)
export class NonceStoreCapacityError extends Error {
  constructor(message: string = 'Nonce store capacity exceeded') {
    super(message)
    this.name = 'NonceStoreCapacityError'
  }
}

// Nonce storage interface - in production this would use Redis or similar
export interface NonceStore {
  issue(address: string, logger?: AuthLogger): Promise<string>
  consume(address: string, nonce: string): Promise<boolean>
}

// A member's address is their on-chain identity — logging it in full on every
// request links identity to request timing (issue #133). Truncate the way a
// block explorer does (first 4 / last 4 chars) so debug output stays useful
// for eyeballing without writing the full address to disk on every request.
function truncateAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

// In-memory nonce store for development
export class MemoryNonceStore implements NonceStore {
  private store = new Map<string, { nonce: string; expiresAt: number }>()
  private readonly TTL_MS = 5 * 60 * 1000 // 5 minutes
  private readonly MAX_ENTRIES = 10000 // Hard cap on stored entries
  private sweepTimer: NodeJS.Timeout | null = null

  constructor() {
    // Start periodic sweep of expired entries, unref'd so it doesn't hold process open
    this.startSweep()
  }

  private startSweep(): void {
    // Sweep every minute to clean up expired entries
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      let evictedCount = 0
      for (const [key, entry] of this.store.entries()) {
        if (entry.expiresAt < now) {
          this.store.delete(key)
          evictedCount++
        }
      }
      if (evictedCount > 0) {
        // Could log this if needed: console.debug(`MemoryNonceStore: evicted ${evictedCount} expired entries`)
      }
    }, 60 * 1000) // Every minute
    // Unref the timer so it doesn't prevent graceful shutdown
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref()
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  async issue(address: string, logger?: AuthLogger): Promise<string> {
    const now = Date.now()

    // Check if we already have an unexpired nonce for this address
    const existingEntry = this.store.get(address)
    if (existingEntry) {
      if (existingEntry.expiresAt > now) {
        // Nonce is still valid - return existing one
        // This prevents an attacker from invalidating a victim's nonce
        // and also prevents self-invalidation from multiple tabs
        logger?.debug(`[auth] Returning existing nonce for ${truncateAddress(address)}, expires in ${Math.floor((existingEntry.expiresAt - now) / 1000)}s`)
        logger?.info(`[auth] challenge issued (existing): address=${truncateAddress(address)} nonce_age_sec=${Math.floor((now - (existingEntry.expiresAt - this.TTL_MS)) / 1000)}`)
        authStats.challengesIssued++
        return existingEntry.nonce
      } else {
        // Nonce has expired, clean it up
        this.store.delete(address)
      }
    }
    
    // If we're at capacity, reject new challenges to prevent DoS
    if (this.store.size >= this.MAX_ENTRIES) {
      throw new NonceStoreCapacityError()
    }
    
    // Generate a random 32-byte nonce (64 hex chars)
    const nonce = randomBytes(32).toString('hex')
    
    this.store.set(address, {
      nonce,
      expiresAt: now + this.TTL_MS
    })
    
    logger?.info(`[auth] challenge issued (new): address=${truncateAddress(address)}`)
    authStats.challengesIssued++
    return nonce
  }

  async consume(address: string, nonce: string): Promise<boolean> {
    const entry = this.store.get(address)
    if (!entry) return false
    if (entry.expiresAt < Date.now()) {
      this.store.delete(address)
      return false
    }
    if (entry.nonce !== nonce) return false
    this.store.delete(address)
    return true
  }
}

// Postgres-backed nonce store for production (issue #66)
// Uses atomic DELETE ... WHERE to ensure a nonce can only be consumed once,
// even with concurrent requests across multiple API instances.
export class PostgresNonceStore implements NonceStore {
  private pool: Pool
  private readonly TTL_MS = 5 * 60 * 1000 // 5 minutes
  private cleanupTimer: NodeJS.Timeout | null = null
  // Background timer, not tied to any one request — falls back to this
  // base logger (e.g. `app.log`) rather than the per-call logger `issue()` gets.
  private readonly logger?: AuthLogger

  constructor(pool: Pool, logger?: AuthLogger) {
    this.pool = pool
    this.logger = logger
    this.startCleanup()
  }

  private startCleanup(): void {
    // Clean up expired nonces every 10 minutes
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.pool.query(
          `DELETE FROM auth_nonces WHERE expires_at <= now()`
        )
      } catch (error) {
        // Log but don't throw - cleanup failure shouldn't crash the process
        this.logger?.warn(`[auth] expired-nonce cleanup failed: ${(error as Error).message}`)
      }
    }, 10 * 60 * 1000) // Every 10 minutes
    // Unref the timer so it doesn't prevent graceful shutdown
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  async issue(address: string, logger?: AuthLogger): Promise<string> {
    // First, check if there's an existing unexpired nonce
    const existingResult = await this.pool.query(
      `SELECT nonce FROM auth_nonces
       WHERE address = $1 AND expires_at > now()`,
      [address]
    )

    if (existingResult.rows.length > 0) {
      // Nonce is still valid - return existing one
      // This prevents an attacker from invalidating a victim's nonce
      // and also prevents self-invalidation from multiple tabs
      logger?.debug(`[auth] Returning existing nonce for ${truncateAddress(address)}`)
      logger?.info(`[auth] challenge issued (existing): address=${truncateAddress(address)}`)
      authStats.challengesIssued++
      return existingResult.rows[0].nonce
    }
    
    const expiresAt = new Date(Date.now() + this.TTL_MS)
    const nonce = randomBytes(32).toString('hex')
    
    // Insert the nonce. If an address already has a nonce (but expired), replace it
    await this.pool.query(
      `INSERT INTO auth_nonces (address, nonce, expires_at) 
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE 
       SET nonce = $2, expires_at = $3`,
      [address, nonce, expiresAt]
    )

    logger?.info(`[auth] challenge issued (new): address=${truncateAddress(address)}`)
    authStats.challengesIssued++
    return nonce
  }

  async consume(address: string, nonce: string): Promise<boolean> {
    // Atomically: DELETE the row if it exists, not expired, and nonce matches
    const result = await this.pool.query(
      `DELETE FROM auth_nonces 
       WHERE address = $1 AND nonce = $2 AND expires_at > now()
       RETURNING address`,
      [address, nonce]
    )

    // If a row was deleted, the nonce was valid
    return result.rows.length > 0
  }
}

/** The Stellar address families the auth path can encounter. */
export type StellarAddressType = 'ed25519' | 'muxed' | 'contract' | 'invalid'

export function classifyStellarAddress(address: string): StellarAddressType {
  if (StrKey.isValidEd25519PublicKey(address)) return 'ed25519'
  if (StrKey.isValidMed25519PublicKey(address)) return 'muxed'
  if (StrKey.isValidContract(address)) return 'contract'
  return 'invalid'
}

/**
 * Result of {@link verifySignature}. A failure carries the HTTP status the
 * caller should use and a client-safe message — an *unsupported address type*
 * is a 400 with an accurate reason, not a 401 "Invalid signature" (issue #71).
 * Failure-mode detail is written to the log, never returned here.
 */
export type SignatureResult =
  | { ok: true; ed25519Address: string }
  | { ok: false; status: 400 | 401; error: string }

const ED25519_SIGNATURE_BYTES = 64

export function verifySignature(
  address: string,
  nonce: string,
  signature: string,
  logger?: AuthLogger
): SignatureResult {
  const type = classifyStellarAddress(address)

  if (type === 'invalid') {
    logger?.warn(`[auth] verification failed: reason=unsupported_address_type address=${truncateAddress(address)}`)
    authStats.verificationsFailed.unsupportedAddressType++
    return { ok: false, status: 400, error: 'Unrecognized Stellar address format' }
  }

  // Contract (C…) accounts authorize through the contract's `__check_auth`,
  // which requires an on-chain RPC call to verify — they cannot produce an
  // ed25519 signature at all. Unsupported here; see README "Security notes".
  // Follow-up for `__check_auth` verification: tracked separately.
  if (type === 'contract') {
    logger?.warn(`[auth] verification failed: reason=unsupported_address_type address=${truncateAddress(address)} type=contract`)
    authStats.verificationsFailed.unsupportedAddressType++
    return {
      ok: false,
      status: 400,
      error: 'Contract (C…) accounts are not supported for authentication',
    }
  }

  // Muxed (M…) accounts wrap an underlying G… account that holds the signing
  // key — resolve to it and verify against that key. The signed payload still
  // uses the address exactly as presented in the header.
  let ed25519Address = address
  if (type === 'muxed') {
    try {
      ed25519Address = MuxedAccount.fromAddress(address, '0').baseAccount().accountId()
    } catch (error) {
      logger?.warn(`[auth] verification failed: reason=malformed_muxed_address address=${truncateAddress(address)}`)
      authStats.verificationsFailed.unsupportedAddressType++
      return { ok: false, status: 400, error: 'Malformed muxed (M…) address' }
    }
  }

  // Buffer.from(_, 'base64') never throws — it silently drops invalid
  // characters — so a wrong-length result is how a malformed encoding shows
  // up. An ed25519 signature is exactly 64 bytes; anything else is a bad
  // encoding, logged distinctly from a valid-but-wrong signature.
  const signatureBuffer = Buffer.from(signature, 'base64')
  if (signatureBuffer.length !== ED25519_SIGNATURE_BYTES) {
    logger?.warn(
      `[auth] verification failed: reason=malformed_encoding address=${truncateAddress(address)} decoded_bytes=${signatureBuffer.length} expected=${ED25519_SIGNATURE_BYTES}`
    )
    authStats.verificationsFailed.malformedEncoding++
    return { ok: false, status: 401, error: 'Invalid signature' }
  }

  const data = Buffer.from(`${nonce}:${address}`, 'utf8')
  try {
    const keypair = Keypair.fromPublicKey(ed25519Address)
    if (!keypair.verify(data, signatureBuffer)) {
      logger?.warn(`[auth] verification failed: reason=invalid_signature address=${truncateAddress(address)}`)
      authStats.verificationsFailed.invalidSignature++
      return { ok: false, status: 401, error: 'Invalid signature' }
    }
    logger?.info(`[auth] verification succeeded: address=${truncateAddress(address)}`)
    authStats.verificationsSucceeded++
    return { ok: true, ed25519Address }
  } catch (error) {
    logger?.warn(`[auth] verification failed: reason=invalid_signature address=${truncateAddress(address)} error=${(error as Error).message}`)
    authStats.verificationsFailed.invalidSignature++
    return { ok: false, status: 401, error: 'Invalid signature' }
  }
}

// Helper to extract and validate auth headers
export function extractAuthHeaders(headers: Record<string, unknown>): {
  address: string | null
  signature: string | null
  nonce: string | null
} {
  const authHeader = headers['authorization']
  if (typeof authHeader !== 'string') {
    return { address: null, signature: null, nonce: null }
  }

  // Format: StellarSignature <address>:<signature>:<nonce>
  if (!authHeader.startsWith('StellarSignature ')) {
    return { address: null, signature: null, nonce: null }
  }

  const parts = authHeader.slice('StellarSignature '.length).split(':')
  if (parts.length !== 3) {
    return { address: null, signature: null, nonce: null }
  }

  const [address, signature, nonce] = parts
  return { address: address ?? null, signature: signature ?? null, nonce: nonce ?? null }
}

// Validate a string as a Stellar public key
export function isValidStellarAddress(address: string): boolean {
  try {
    // Use StrKey to validate
    return StrKey.isValidEd25519PublicKey(address)
  } catch {
    return false
  }
}

/**
 * Result of {@link authenticateRequest}. A discriminated union so the type
 * checker refuses `result.address` unless `authenticated` is `true` — an
 * authorization check can only ever compare against the address that was
 * actually authenticated, never a separately re-parsed one (issue #70).
 */
export type AuthResult =
  | { authenticated: false; status: number; error: string }
  | { authenticated: true; address: string }

// Authentication middleware function
export async function authenticateRequest(
  headers: Record<string, unknown>,
  nonceStore: NonceStore,
  targetAddress?: string,
  logger?: AuthLogger,
  failureTracker?: AuthFailureTracker
): Promise<AuthResult> {
  const { address, signature, nonce } = extractAuthHeaders(headers)

  if (!address || !signature || !nonce) {
    logger?.warn(`[auth] authentication failed: reason=missing_headers has_address=${!!address} has_signature=${!!signature} has_nonce=${!!nonce}`)
    authStats.verificationsFailed.missingHeaders++
    return { authenticated: false, status: 401, error: 'Missing authentication headers' }
  }

  // Check if this address is currently under backoff (issue #184)
  if (failureTracker && !failureTracker.isAllowed(address)) {
    const backoffMs = failureTracker.getRemainingBackoff(address)
    logger?.warn(`[auth] authentication blocked: reason=backoff address=${truncateAddress(address)} backoff_ms=${backoffMs}`)
    return { 
      authenticated: false, 
      status: 429, 
      error: `Too many failed attempts. Try again in ${Math.ceil(backoffMs / 1000)} seconds` 
    }
  }

  // Verify the signature first — consuming the nonce before this would let
  // anyone who reads a victim's (non-secret, by design) challenge burn it
  // with a garbage signature, denying the victim's real request (issue #115).
  const sig = verifySignature(address, nonce, signature, logger)
  if (!sig.ok) {
    failureTracker?.recordFailure(address)
    return { authenticated: false, status: sig.status, error: sig.error }
  }

  // Only now consume the nonce, so a bad signature never spends it.
  const nonceValid = await nonceStore.consume(address, nonce)
  if (!nonceValid) {
    logger?.warn(`[auth] authentication failed: reason=invalid_nonce address=${truncateAddress(address)}`)
    authStats.verificationsFailed.invalidNonce++
    failureTracker?.recordFailure(address)
    return { authenticated: false, status: 401, error: 'Invalid or expired nonce' }
  }

  // If a target address is provided, ensure it matches the authenticated address.
  // 403, not 401 — the caller *is* authenticated, they're just not authorized
  // to act on another address, and this must match the ownership check in
  // PATCH /notifications/:id/read for the same condition (issue #134).
  if (targetAddress && targetAddress !== address) {
    logger?.warn(`[auth] authentication failed: reason=address_mismatch authenticated=${truncateAddress(address)} target=${truncateAddress(targetAddress)}`)
    authStats.verificationsFailed.addressMismatch++
    // Don't count address mismatch toward backoff — it's not a brute-force attempt
    return { authenticated: false, status: 403, error: 'Cannot modify notifications for another address' }
  }

  logger?.info(`[auth] authentication succeeded: address=${truncateAddress(address)}`)
  failureTracker?.recordSuccess(address)
  return { authenticated: true, address }
}

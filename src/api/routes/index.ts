import type { FastifyInstance } from 'fastify'
import { StrKey } from '@stellar/stellar-sdk'
import { query, queryOne, withTransaction } from '../../db/index.js'
import { config } from '../../config.js'
import {
  ADMIN_EVENT_SYMBOLS,
  LOAN_TIMELINE_SYMBOLS,
  TREASURY_TIMELINE_SYMBOLS,
  MEMBER_ACTIVITY_SYMBOLS,
  namedFields,
} from '../../stellar/events.js'
import type {
  DAOStats,
  LoanProposalRow,
  LoanRow,
  MemberRow,
  MemberSummary,
  NotificationRow,
  TreasuryProposalRow,
  EventRow,
  InterestDistributionRow,
  DocumentRow,
  FailedEventRow,
  TimelineEntry,
  AdminAuditLogRow,
  AdminAuditAction,
} from '../../types.js'
import { authenticateRequest, classifyStellarAddress, NonceStoreCapacityError, type NonceStore } from '../../auth.js'
import { getConnectedStreamCount, getNotificationFailureCount, registerStreamEndpoint } from '../stream.js'
import { historicalOrLive, setCachePolicy } from '../cache-policy.js'
import { ConcurrencyGate } from '../load-shedding.js'
import { withLoanDerived } from '../loan-derived.js'
import { getOrSetCache, membersListCacheKey, memberSummaryCacheKey } from '../../cache/redis.js'
import { replayFailedEvent } from '../../indexer/replay.js'
import { createHistoryCache } from '../history-cache.js'

function parseLimit(v: unknown, def = 50, max = 200): number | null {
  if (v === undefined || v === null || v === '') return def
  const raw = String(v).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) return null
  return n
}

function invalidLimit(v: unknown, def = 50, max = 200): boolean {
  return parseLimit(v, def, max) === null
}

// Issue #165: how many of a member's loans /members/:address/summary embeds
// inline. The full history is always available, paginated, from
// GET /api/loans?borrower=<address> — this cap only bounds the size of the
// summary payload itself. Named so the LIMIT and the has-more comparison
// it's checked against can never drift apart.
const LOANS_EMBED_LIMIT = 100

// Small helper: clamp a `limit` query param to a sane range.
function limit(v: unknown, def = 50, max = 200): number {
  return parseLimit(v, def, max) ?? def
}

// Parse an optional numeric pagination cursor (e.g. `?before=`). Returns null
// when absent or invalid, meaning "start from the newest row."
function cursor(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const raw = String(v).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function invalidCursor(v: unknown): boolean {
  return v !== undefined && cursor(v) === null
}

function eventCursor(v: unknown): { ledger: number, id?: string } | null {
  if (v === undefined || v === null || v === '') return null
  const raw = String(v).trim()
  if (/^[0-9]+-[0-9]+$/.test(raw)) {
    const ledger = Number(raw.split('-')[0])
    return { ledger, id: raw }
  }
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? { ledger: n } : null
}

function invalidEventCursor(v: unknown): boolean {
  return v !== undefined && eventCursor(v) === null
}

// Issue #278: `?from_ledger=`/`?to_ledger=` on /events. Parses a single bound
// to a non-negative integer, or null if absent/malformed (mirrors `cursor`
// above). Ledger 0 is a legitimate lower bound (the genesis ledger), unlike
// the `cursor`/`limit` helpers above where 0 means "absent" — so this can't
// reuse those.
function ledgerBound(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const raw = String(v).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

// Issue #278: max span a single from_ledger/to_ledger query may cover — wide
// enough for any realistic dashboard range query, and small enough that a
// full-range scan can't be used to force an unbounded sequential scan.
const MAX_LEDGER_RANGE = 10_000

// Validates `from_ledger`/`to_ledger` together: each must be a well-formed
// non-negative integer when present, `from_ledger <= to_ledger` when both are
// given, and the span between them must not exceed MAX_LEDGER_RANGE. A
// single bound (only `from_ledger` or only `to_ledger`) has no span to check.
function invalidLedgerRange(fromRaw: unknown, toRaw: unknown): boolean {
  if (fromRaw !== undefined && ledgerBound(fromRaw) === null) return true
  if (toRaw !== undefined && ledgerBound(toRaw) === null) return true
  const from = ledgerBound(fromRaw)
  const to = ledgerBound(toRaw)
  if (from !== null && to !== null) {
    if (from > to) return true
    if (to - from > MAX_LEDGER_RANGE) return true
  }
  return false
}

function validAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address)
}

function isMemberActivitySymbol(v: unknown): v is (typeof MEMBER_ACTIVITY_SYMBOLS)[number] {
  return typeof v === 'string' && (MEMBER_ACTIVITY_SYMBOLS as readonly string[]).includes(v)
}

// Validate a positive integer path param (loan / proposal id). Returns the
// trimmed decimal string on success (kept as a string so it compares
// directly against the JSONB-extracted `data->>0`), or null.
function entityIdParam(v: string): string | null {
  const raw = v.trim()
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) return null
  return raw
}

// Decode one raw `events` row into a timeline entry (issue #26): named fields
// via the EVENT_FIELDS catalog rather than the raw positional tuple, so a
// client doesn't reimplement the decoder.
function toTimelineEntry(row: EventRow): TimelineEntry {
  const data = Array.isArray(row.data) ? (row.data as unknown[]) : []
  return {
    id: row.id,
    symbol: row.symbol,
    ledger: row.ledger,
    timestamp: row.closed_at,
    tx_hash: row.tx_hash,
    fields: namedFields(row.symbol, data),
  }
}

// A single loan / treasury proposal produces a bounded lifecycle (a request,
// an approval, an execution, and one vote per member), but "one vote per
// member" is only bounded by the membership size — so cap the timeline query
// defensively rather than leaving it unbounded. Comfortably above any real
// DAO's per-proposal event count; a client that hits it can page /api/events.
const TIMELINE_MAX_ROWS = 2000

// Shared implementation for the two per-entity timeline endpoints. `symbols`
// is the lifecycle set for the entity family; the id is matched against the
// first `data` tuple entry (`data->>0`), which every symbol in these sets
// carries — see LOAN_TIMELINE_SYMBOLS / TREASURY_TIMELINE_SYMBOLS.
async function entityTimeline(symbols: readonly string[], id: string): Promise<TimelineEntry[]> {
  const rows = await query<EventRow>(
    `SELECT * FROM events
       WHERE symbol = ANY($1) AND data->>0 = $2
       ORDER BY ledger ASC, id ASC
       LIMIT $3`,
    [symbols as string[], id, TIMELINE_MAX_ROWS]
  )
  return rows.map(toTimelineEntry)
}

// Issue #277: pulled out of the route handler so it can be called from
// inside `getOrSetCache`'s fetcher without the handler itself growing an
// inline template-literal SQL block wrapped in another closure. Behavior is
// unchanged from before this issue — same CTEs, same shape, `null` when the
// address has no member row.
async function fetchMemberSummary(address: string): Promise<MemberSummary | null> {
  const row = await queryOne<{ summary: MemberSummary }>(`
    WITH m AS (
      SELECT * FROM members WHERE address = $1
    ),
    totals AS (
      -- Issue #164: both denominators must match the contract's own
      -- definition of a member's claim. calculate_exit_share() in
      -- ourdao-contracts (contracts/dao/src/membership.rs) computes
      -- treasury * contribution / total_active_contributions, where
      -- total_active_contributions sums 'contribution' only over members
      -- with MemberStatus::ActiveMember — the same exited = false this
      -- table already (correctly) uses for total_stake, and for
      -- active_members/total_staked in /api/stats. contribution_share_bps
      -- is therefore a member's share of *currently active* contribution,
      -- matching what the contract would actually pay on exit, not a
      -- share of every contribution ever made including exited members'.
      SELECT
        (SELECT COALESCE(SUM(contribution), 0) FROM members WHERE exited = false) as total_contribution,
        (SELECT COALESCE(SUM(stake), 0) FROM members WHERE exited = false) as total_stake
    ),
    unread_notifs AS (
      SELECT COUNT(*) as unread_count FROM notifications WHERE address = $1 AND read = false
    ),
    -- Issue #165: aggregates run over the member's *entire* loan history —
    -- independent of ${LOANS_EMBED_LIMIT}, the cap on the embedded list
    -- below — so a long-tenured member's repaid/defaulted counts and
    -- defaulted value are never silently wrong just because they have
    -- more than ${LOANS_EMBED_LIMIT} loans.
    member_loans_agg AS (
      SELECT COUNT(*) as total_count,
             COUNT(*) FILTER (WHERE status = 'repaid') as repaid_loans_count,
             COUNT(*) FILTER (WHERE status = 'defaulted') as defaulted_loans_count,
             COALESCE(SUM(outstanding) FILTER (WHERE status = 'defaulted'), 0) as defaulted_loans_value
      FROM loans WHERE borrower = $1
    ),
    -- The embedded list itself stays capped at ${LOANS_EMBED_LIMIT} (full
    -- history is available, paginated, from GET /api/loans?borrower=) but
    -- now with an explicit column list instead of SELECT *, and the
    -- truncation is now visible via loans_total_count/loans_truncated
    -- below rather than silent.
    member_loans_embed AS (
      SELECT COALESCE(json_agg(row_to_json(l)), '[]'::json) as loans
      FROM (
        SELECT id, borrower, amount, outstanding, total_repayment, status,
               approved_ledger, due_time, repaid_ledger, defaulted_ledger, updated_at
        FROM loans WHERE borrower = $1 ORDER BY id DESC LIMIT ${LOANS_EMBED_LIMIT}
      ) l
    )
    SELECT
      json_build_object(
        'member', row_to_json(m.*),
        'loans', (SELECT loans FROM member_loans_embed),
        'loans_total_count', (SELECT total_count::int FROM member_loans_agg),
        'loans_truncated', (SELECT total_count > ${LOANS_EMBED_LIMIT} FROM member_loans_agg),
        'unread_notifications', (SELECT unread_count::int FROM unread_notifs),
        'position', json_build_object(
          'contribution_share_bps', CASE
            WHEN (SELECT total_contribution FROM totals) > 0 AND m.exited = false
            THEN TRUNC((m.contribution * 10000) / (SELECT total_contribution FROM totals))::text
            ELSE '0'
          END,
          'stake_share_bps', CASE
            WHEN (SELECT total_stake FROM totals) > 0 AND m.exited = false
            THEN TRUNC((m.stake * 10000) / (SELECT total_stake FROM totals))::text
            ELSE '0'
          END,
          'repaid_loans_count', COALESCE((SELECT repaid_loans_count::int FROM member_loans_agg), 0),
          'defaulted_loans_count', COALESCE((SELECT defaulted_loans_count::int FROM member_loans_agg), 0),
          'defaulted_loans_value', COALESCE((SELECT defaulted_loans_value FROM member_loans_agg), 0)::text
        )
      ) as summary
    FROM m
  `, [address])

  return row?.summary ?? null
}

// Issue #291: write one row to admin_audit_log for every authenticated admin
// action. Called fire-and-forget — a logging failure must never block the
// action itself; errors are logged via the request logger so they appear in
// the operator's log stream with the same correlation id as the action.
//
// `ip` is the request IP (req.ip in Fastify, which respects TRUST_PROXY); it
// is stored as-is — trust level depends on how the server is deployed.
// `payload` is an action-specific object (event id, ledger, etc.) that gives
// an auditor enough context to reconstruct what changed.
async function writeAuditLog(
  adminAddress: string,
  action: AdminAuditAction | string,
  ip: string | null,
  payload: Record<string, unknown>,
  log: { error(obj: unknown, msg: string): void }
): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_address, action, ip_address, payload)
       VALUES ($1, $2, $3, $4)`,
      [adminAddress, action, ip ?? null, JSON.stringify(payload)]
    )
  } catch (err) {
    // Never let a logging failure surface to the caller — log it and move on.
    log.error({ err }, `[audit] failed to write audit log entry action=${action}`)
  }
}

export async function registerRoutes(app: FastifyInstance, opts: { nonceStore: NonceStore }): Promise<void> {
  const { nonceStore } = opts
  const historyCache = createHistoryCache()
  app.addHook('onClose', async () => historyCache.close())

  // --- SSE stream (issues #63, #158) ---
  // Registered inside the `/api` plugin so it inherits the prefix and any
  // future plugin-scoped hooks. See registerStreamEndpoint for the rate-limit
  // decision (handshake stays rate-limited; open connections use STREAM_MAX_*).
  await registerStreamEndpoint(app)

  // --- Authentication challenge (issue #65) ---
  // Stricter rate limit on this endpoint to prevent DoS attacks
  app.get<{ Querystring: { address: string } }>('/auth/challenge', {
    config: {
      rateLimit: {
        max: config.http.rateLimitEventsMax, // Use the same stricter limit as /events
        timeWindow: config.http.rateLimitWindowMs,
      },
    },
  }, async (req, reply) => {
    const { address } = req.query
    if (!address) {
      return reply.code(400).send({ error: 'address query param is required' })
    }
    
    // Validate address is a well-formed Stellar address (issue #65). Accept
    // both families verifySignature can resolve — ed25519 and muxed (issue
    // #116) — and reject contract (C…) and anything malformed.
    const addressType = classifyStellarAddress(address)
    if (addressType !== 'ed25519' && addressType !== 'muxed') {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }

    try {
      const nonce = await nonceStore.issue(address, req.log)
      return { nonce }
    } catch (error) {
      if (error instanceof NonceStoreCapacityError) {
        return reply.code(503).send({ error: 'Service temporarily unavailable' })
      }
      throw error
    }
  })
  
  // --- Members ---
  // `joined_ledger IS NOT NULL` filters out phantom rows — an address that
  // only ever appeared in a `name_reg`/`staked` event and never actually
  // joined the DAO (issue #14). A real member always has a join ledger.
  app.get('/members', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    // Issue #277: this ordered member listing is the closest thing this
    // codebase has to a "leaderboard" and, like /members/:address/summary
    // below, is heavy enough (full table scan + sort) to be worth a
    // short-lived read-through cache. Falls straight through to Postgres
    // when REDIS_URL isn't configured — see src/cache/redis.ts.
    return getOrSetCache(membersListCacheKey(l), config.cache.memberCacheTtlSeconds, () =>
      query<MemberRow>(
        `SELECT * FROM members
          WHERE exited = false AND joined_ledger IS NOT NULL
          ORDER BY joined_ledger DESC NULLS LAST LIMIT $1`,
        [l]
      )
    )
  })

  app.get<{ Params: { address: string } }>('/members/:address', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    const m = await queryOne<MemberRow>('SELECT * FROM members WHERE address = $1', [req.params.address])
    if (!m) return reply.code(404).send({ error: 'member not found' })
    return m
  })

  app.get<{ Params: { address: string } }>('/members/:address/summary', async (req, reply) => {
    setCachePolicy(reply, 'private')
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }

    // Issue #277: this is one of the heaviest reads in the API (several CTEs,
    // an aggregate over the member's full loan history) and is keyed
    // per-address, so it's cached the same way as /api/members above. A
    // "member not found" result is cached too (as `null`) rather than
    // special-cased out of the cache — the `joined` handler's cache
    // invalidation (see src/indexer/poller.ts) clears exactly this key the
    // moment that address actually becomes a member, so a fresh join is
    // never stuck behind a stale negative lookup for the full TTL.
    const address = req.params.address
    const result = await getOrSetCache(memberSummaryCacheKey(address), config.cache.memberCacheTtlSeconds, async () => {
      const summary = await fetchMemberSummary(address)
      if (!summary) return null
      if (summary.loans && Array.isArray(summary.loans)) {
        summary.loans = summary.loans.map((l) => withLoanDerived(l, req.log))
      }
      return summary
    })

    if (!result) return reply.code(404).send({ error: 'member not found' })
    return result
  })

  // --- A member's cross-entity activity feed (issue #26) ---
  // The obvious sibling of the per-loan / per-proposal timelines: every event
  // that names this address as a participant, newest first, across joins,
  // stakes, loans and votes. Matches the address in any position of the
  // JSONB `data` tuple (it sits at a different offset per symbol) and
  // restricts to MEMBER_ACTIVITY_SYMBOLS so an address that only appears as
  // e.g. a treasury `destination` doesn't show up here. `?before=<ledger>`
  // cursor, like the other historical feeds.
  app.get<{ Params: { address: string } }>('/members/:address/activity', {
    schema: {
      tags: ['Members'],
      summary: "A member's cross-entity activity feed",
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'string', description: 'Max rows to return (1-200, default 50).' },
          before: { type: 'string', description: 'Pagination cursor: return rows from ledgers strictly below this value.' },
          symbol: {
            type: 'string',
            enum: [...MEMBER_ACTIVITY_SYMBOLS],
            description: 'Narrow the feed to one activity kind (issue #193). Must be one of the member-activity symbols; anything else is a 400.',
          },
        },
      },
    },
  }, async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    if (!validAddress(req.params.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })

    // Issue #193: `?symbol=` narrows the feed to one activity kind. A symbol
    // outside MEMBER_ACTIVITY_SYMBOLS is rejected explicitly — the unfiltered
    // query could never have returned it, so a silently empty page would
    // only hide a client typo.
    const symbolFilter = q.symbol
    if (symbolFilter !== undefined && !isMemberActivitySymbol(symbolFilter)) {
      return reply.code(400).send({
        error: `invalid symbol filter: expected one of ${MEMBER_ACTIVITY_SYMBOLS.join(', ')}`,
      })
    }

    // With a symbol the predicate is an equality on the btree-indexed column
    // plus the GIN containment; without one it stays `= ANY(...)` over the
    // whole activity set. Plans for both shapes are recorded in
    // docs/member-activity-query-plan.md.
    const params: unknown[] = [
      symbolFilter ?? (MEMBER_ACTIVITY_SYMBOLS as unknown as string[]),
      req.params.address,
    ]
    let where = symbolFilter !== undefined
      ? `WHERE symbol = $1 AND data @> to_jsonb($2::text)`
      : `WHERE symbol = ANY($1) AND data @> to_jsonb($2::text)`
    if (before !== null) {
      params.push(before)
      where += ` AND ledger < $${params.length}`
    }
    params.push(l)
    const rows = await query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
    return { activity: rows.map(toTimelineEntry) }
  })

  // --- Loan proposals ---
  app.get('/proposals/loan', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const rows = await query<LoanProposalRow>('SELECT * FROM loan_proposals ORDER BY id DESC LIMIT $1', [l])
    // The contract applies stake-weighted voting internally, but doesn't yet
    // publish `weight` on `loan_vote` — every tally here is an unweighted
    // headcount that can disagree with the on-chain result (issue #126).
    // Flag it explicitly rather than presenting it as authoritative.
    return rows.map((r) => ({ ...r, tallies_weighted: false }))
  })

  // --- Loans (optional ?borrower= filter, ?before=<id> cursor) ---
  app.get('/loans', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    if (q.borrower !== undefined && q.borrower !== null && q.borrower !== '') {
      if (typeof q.borrower !== 'string' || !validAddress(q.borrower)) {
        return reply.code(400).send({ error: 'invalid Stellar address' })
      }
    }
    const borrower = typeof q.borrower === 'string' && q.borrower ? q.borrower : null

    const conditions: string[] = []
    const params: unknown[] = []
    if (borrower) {
      params.push(borrower)
      conditions.push(`borrower = $${params.length}`)
    }
    if (before !== null) {
      params.push(before)
      conditions.push(`id < $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    const loans = await query<LoanRow>(`SELECT * FROM loans ${where} ORDER BY id DESC LIMIT $${params.length}`, params)
    return loans.map((l) => withLoanDerived(l, req.log))
  })

  app.get<{ Params: { id: string } }>('/loans/:id', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const rawId = req.params.id.trim()
    if (!/^[0-9]+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) {
      return reply.code(400).send({ error: 'invalid loan id' })
    }
    const loan = await queryOne<LoanRow>('SELECT * FROM loans WHERE id = $1', [Number(rawId)])
    if (!loan) return reply.code(404).send({ error: 'loan not found' })
    return withLoanDerived(loan, req.log)
  })

  // --- A loan's full event history (issue #26) ---
  // Every state change to a loan — requested, edited, voted on, approved,
  // repaid or defaulted — is in the raw event log already, but reconstructing
  // it meant paging the whole `/api/events` feed and filtering client-side on
  // an id buried in the JSONB `data` column. This is the query on-chain state
  // can't answer (the contract keeps no queryable history) and this service
  // exists for. `loans.id == loan_proposals.id` by contract invariant, so one
  // id covers the whole lifecycle. A nonexistent id returns an empty timeline
  // (200), not a 404 — the loan may simply have no events yet, and the caller
  // asked "what happened to this id", which is legitimately "nothing".
  app.get<{ Params: { id: string } }>('/loans/:id/timeline', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const id = entityIdParam(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid loan id' })
    return { timeline: await entityTimeline(LOAN_TIMELINE_SYMBOLS, id) }
  })

  // --- Treasury proposals ---
  app.get('/proposals/treasury', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const rows = await query<TreasuryProposalRow>('SELECT * FROM treasury_proposals ORDER BY id DESC LIMIT $1', [l])
    // See the matching comment on GET /proposals/loan above (issue #126).
    return rows.map((r) => ({ ...r, tallies_weighted: false }))
  })

  // --- A treasury proposal's full event history (issue #26) ---
  // The treasury-lifecycle equivalent of `/loans/:id/timeline`: proposed,
  // voted on, committed and revealed (the commit–reveal path for private
  // proposals), executed. Loan and treasury proposal ids are drawn from
  // independent sequences and collide, so this is a distinct route rather
  // than a shared `/proposals/:id/timeline`. Same empty-not-404 contract.
  app.get<{ Params: { id: string } }>('/proposals/treasury/:id/timeline', async (req, reply) => {
    setCachePolicy(reply, 'public-live')
    const id = entityIdParam(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid proposal id' })
    return { timeline: await entityTimeline(TREASURY_TIMELINE_SYMBOLS, id) }
  })

  // --- Notifications for an address (optional ?before=<id> cursor) ---
  app.get('/notifications', async (req, reply) => {
    setCachePolicy(reply, 'private')
    const q = req.query as Record<string, unknown>
    if (typeof q.address !== 'string' || !q.address || !validAddress(q.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })

    const conditions = ['address = $1']
    const params: unknown[] = [q.address]
    if (before !== null) {
      params.push(before)
      conditions.push(`id < $${params.length}`)
    }
    params.push(l)
    return query<NotificationRow>(
      `SELECT * FROM notifications WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Raw event feed (optional ?symbol= filter, ?before=<ledger> cursor) ---
  // Stricter rate limit on this heavy endpoint (issue #5).
  app.get('/events', {
    config: {
      rateLimit: {
        max: config.http.rateLimitEventsMax,
        timeWindow: config.http.rateLimitWindowMs,
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = eventCursor(q.before)
    const after = eventCursor(q.after)
    
    if (invalidEventCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    if (invalidEventCursor(q.after)) return reply.code(400).send({ error: 'invalid after cursor' })
    if (before !== null && after !== null) return reply.code(400).send({ error: 'cannot use before and after together' })

    // Issue #278: ledger-range filter, additive with symbol/contract/
    // decode_error/before/after below.
    if (invalidLedgerRange(q.from_ledger, q.to_ledger)) {
      return reply.code(400).send({
        error: 'invalid ledger range: from_ledger/to_ledger must be non-negative integers, from_ledger <= to_ledger, and the range must not exceed 10000 ledgers',
      })
    }
    const fromLedger = ledgerBound(q.from_ledger)
    const toLedger = ledgerBound(q.to_ledger)

    const order = typeof q.order === 'string' && q.order === 'asc' ? 'ASC' : 'DESC'

    setCachePolicy(reply, historicalOrLive(before !== null || after !== null))

    const symbol = typeof q.symbol === 'string' && q.symbol ? q.symbol : null
    const contract = typeof q.contract === 'string' && q.contract ? q.contract : null
    const decodeError = q.decode_error === 'true'

    const conditions: string[] = []
    const params: unknown[] = []
    if (symbol) {
      params.push(symbol)
      conditions.push(`symbol = $${params.length}`)
    }
    if (contract) {
      params.push(contract)
      conditions.push(`contract_id = $${params.length}`)
    }
    if (decodeError) {
      conditions.push(`decode_error IS NOT NULL`)
    }
    // Issue #278: plain `ledger >= $N` / `ledger <= $N` — no function or cast
    // wraps the column, so Postgres can still use events_ledger_id_idx
    // (a btree on (ledger, id), see src/db/migrations/0015_events_ledger_id_idx.sql)
    // for these range conditions.
    if (fromLedger !== null) {
      params.push(fromLedger)
      conditions.push(`ledger >= $${params.length}`)
    }
    if (toLedger !== null) {
      params.push(toLedger)
      conditions.push(`ledger <= $${params.length}`)
    }
    if (before !== null) {
      if (before.id) {
        params.push(before.ledger, before.id)
        conditions.push(`(ledger, id) < ($${params.length - 1}, $${params.length})`)
      } else {
        params.push(before.ledger)
        conditions.push(`ledger < $${params.length}`)
      }
    }
    if (after !== null) {
      if (after.id) {
        params.push(after.ledger, after.id)
        conditions.push(`(ledger, id) > ($${params.length - 1}, $${params.length})`)
      } else {
        params.push(after.ledger)
        conditions.push(`ledger > $${params.length}`)
      }
    }
    
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    
    const events = await query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger ${order}, id ${order} LIMIT $${params.length}`,
      params
    )
    
    const response: { events: EventRow[], nextCursor?: string } = { events }
    const lastEvent = events[events.length - 1]
    if (lastEvent) {
      response.nextCursor = lastEvent.id
    }
    return response
  })

  // --- Mark a single notification as read ---
  app.patch<{ Params: { id: string } }>('/notifications/:id/read', async (req, reply) => {
    // First authenticate the request
    const auth = await authenticateRequest(req.headers, nonceStore, undefined, req.log)
    if (!auth.authenticated) {
      return reply.code(auth.status).send({ error: auth.error || 'Authentication required' })
    }

    const rawId = req.params.id.trim()
    if (!/^[0-9]+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) {
      return reply.code(400).send({ error: 'invalid notification id' })
    }
    const id = Number(rawId)

    // Get the notification to check ownership
    const notification = await queryOne<NotificationRow>(
      'SELECT * FROM notifications WHERE id = $1',
      [id]
    )
    if (!notification) return reply.code(404).send({ error: 'notification not found' })

    // Ownership check uses the address `authenticateRequest` proved control
    // of — never a second parse of the raw header (issue #70).
    if (notification.address !== auth.address) {
      return reply.code(403).send({ error: 'Cannot modify notifications for another address' })
    }
    
    const row = await queryOne<NotificationRow>(
      'UPDATE notifications SET read = true WHERE id = $1 RETURNING *',
      [id]
    )
    if (!row) return reply.code(404).send({ error: 'notification not found' })
    return row
  })

  // --- Mark all of an address's notifications as read ---
  app.patch('/notifications/read-all', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (typeof q.address !== 'string' || !q.address || !validAddress(q.address)) {
      return reply.code(400).send({ error: 'invalid Stellar address' })
    }
    
    // Authenticate the request and verify the address matches
    const auth = await authenticateRequest(req.headers, nonceStore, q.address, req.log)
    if (!auth.authenticated) {
      return reply.code(auth.status).send({ error: auth.error || 'Authentication required' })
    }
    
    const rows = await query<NotificationRow>(
      'UPDATE notifications SET read = true WHERE address = $1 AND read = false RETURNING id',
      [q.address]
    )
    return { updated: rows.length }
  })

  // --- Admin/governance audit log (init, admin add/remove, threshold,
  // policy, pause/unpause) ---
  app.get('/admin/log', {
    // Issue #280: first `schema:` block in this file — see the block comment
    // above /admin/failed-events below for why these two routes only
    // document the response codes their handlers can actually produce (no
    // 401: neither route is auth-gated; no 404: both always return an array,
    // empty or not).
    schema: {
      tags: ['admin'],
      summary: 'Admin/governance audit log',
      description:
        'Raw events for admin/governance-lifecycle symbols only (init, admin add/remove, threshold, policy, pause/unpause) — a public audit trail read straight off the chain. Optionally scoped to one contract deployment.',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'string', description: 'Max rows to return (1-200, default 50).' },
          before: { type: 'string', description: 'Pagination cursor: return rows with a strictly smaller ledger than this value.' },
          contract: { type: 'string', description: 'Restrict to one contract deployment id.' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              ledger: { type: 'integer' },
              closed_at: { type: 'string', format: 'date-time' },
              contract_id: { type: 'string' },
              symbol: { type: 'string' },
              topics: {},
              data: {},
              tx_hash: { type: 'string', nullable: true },
              decode_error: { type: 'string', nullable: true },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    
    setCachePolicy(reply, historicalOrLive(before !== null))
    // `?contract=<C...>` scopes to one deployment, same as /events (issue #16).
    const contract = typeof q.contract === 'string' && q.contract ? q.contract : null
    const params: unknown[] = [ADMIN_EVENT_SYMBOLS as unknown as string[]]
    let where = `WHERE symbol = ANY($1)`
    if (contract) {
      params.push(contract)
      where += ` AND contract_id = $${params.length}`
    }
    params.push(l)
    return query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY ledger DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Interest distribution history (issue #24, ?before=<ledger> cursor) ---
  // One row per `interest` event: the amount the treasury collected and the
  // active-member count at that distribution, so per-member share per
  // distribution is derivable. `amount` is interest *collected* — the
  // contract keeps the indivisible remainder, so it is slightly more than the
  // sum credited to members (documented in the README).
  app.get('/interest', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })
    
    setCachePolicy(reply, historicalOrLive(before !== null))
    
    const params: unknown[] = []
    let where = ''
    if (before !== null) {
      params.push(before)
      where = `WHERE ledger < $${params.length}`
    }
    params.push(l)
    return query<InterestDistributionRow>(
      `SELECT id, ledger, amount, active_members, tx_hash, created_at
         FROM interest_distributions ${where}
        ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Documents attached to proposals (issue #44, ?before=<ledger> cursor) ---
  // One row per `doc_attn` event — existence/history only, never the content
  // hash (still read live from the contract via get_document). A single
  // endpoint rather than per-family routes: loan and treasury proposal ids are
  // drawn from independent sequences and collide, so `proposal_id` is only
  // meaningful alongside `kind`, and one route keeps the pagination/validation
  // logic in one place.
  //
  // Issue #189: every filter is optional, like the other list endpoints —
  // no filter lists all documents newest-ledger-first, `?caller=` a member's
  // attachment history, `?kind=` one proposal family. `?kind=&proposal_id=`
  // is the original per-proposal query, unchanged. Each shape has an index:
  // documents_proposal_idx, documents_caller_idx, documents_ledger_idx.
  app.get('/documents', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })

    setCachePolicy(reply, historicalOrLive(before !== null))

    const params: unknown[] = []
    const conditions: string[] = []
    const kind = q.kind
    if (kind !== undefined || q.proposal_id !== undefined) {
      if (kind !== 'loan' && kind !== 'treasury') {
        return reply.code(400).send({ error: 'kind query param must be "loan" or "treasury"' })
      }
      params.push(kind)
      conditions.push(`kind = $${params.length}`)
    }
    if (q.proposal_id !== undefined) {
      if (typeof q.proposal_id !== 'string' || !/^[0-9]+$/.test(q.proposal_id)) {
        return reply.code(400).send({ error: 'proposal_id query param is required' })
      }
      params.push(Number(q.proposal_id))
      conditions.push(`proposal_id = $${params.length}`)
    }
    if (q.caller !== undefined) {
      if (typeof q.caller !== 'string' || !validAddress(q.caller)) {
        return reply.code(400).send({ error: 'invalid Stellar address' })
      }
      params.push(q.caller)
      conditions.push(`caller = $${params.length}`)
    }
    if (before !== null) {
      params.push(before)
      conditions.push(`ledger < $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    return query<DocumentRow>(
      `SELECT id, proposal_id, kind, caller, ledger, tx_hash, attached_at
         FROM documents ${where}
        ORDER BY ledger DESC, id DESC LIMIT $${params.length}`,
      params
    )
  })

  // --- Quarantined events (issue #43) ---
  // A deterministically-throwing handler no longer wedges the indexer
  // forever — the poller isolates the offending event, records it here
  // (without touching the append-only `events` row), and moves on. This is
  // the operator-facing view of that; `/api/stats.quarantinedEvents` is the
  // dashboard-facing count.
  //
  // Issue #163: the `/admin/` prefix has two different meanings in this file
  // — `/admin/log` is a public governance audit trail read straight off the
  // chain, with nothing sensitive in it, while this endpoint surfaces
  // `failed_events.error`, which is the raw driver/handler exception text
  // `classifyError` goes to some trouble to keep out of every other
  // response. Rather than invent an admin-auth scheme this codebase has no
  // other trace of, `/admin/` here means "operator diagnostics": reachable
  // without authentication, but never echoing back anything an unauthed
  // caller couldn't already learn some other way. So the fix mirrors
  // `classifyError`'s own rule — raw exception text is never put in a
  // response, only logged (and still queryable directly against Postgres by
  // an operator) — rather than gating the whole endpoint behind auth.
  app.get('/admin/failed-events', {
    // Issue #280: documents the quarantine view referenced above — "admin"
    // here means operator diagnostics, not an auth-gated route (see the
    // block comment above this handler), so no 401 is documented; the
    // handler always returns an array (possibly empty), so no 404 either —
    // only the response codes it can actually produce.
    schema: {
      tags: ['admin'],
      summary: 'Quarantined (deterministically-failed) events',
      description:
        'Events whose fold handler threw deterministically and were isolated rather than retried forever (issue #43) — the operator-facing view of the quarantine. Never includes the raw exception text; that is logged, not returned, so this endpoint stays safe to leave unauthenticated.',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'string', description: 'Max rows to return (1-200, default 50).' },
          before: { type: 'string', description: 'Pagination cursor: return rows with a strictly smaller id than this value.' },
          unresolved: { type: 'string', enum: ['true', 'false'], description: 'When "true", only rows a reindex/replay has not yet resolved.' },
          symbol: { type: 'string', description: 'Only failures of events with this symbol (issue #192).' },
          from_ledger: { type: 'string', description: 'Only failures from this ledger onwards (issue #192).' },
          to_ledger: { type: 'string', description: 'Only failures up to and including this ledger (issue #192). With from_ledger, the range may span at most 10000 ledgers.' },
        },
      },
      response: {
        200: {
          type: 'array',
          headers: {
            'x-total-count': {
              type: 'integer',
              description: 'Rows matching every filter except the before cursor: the size of the whole quarantine, however far the page is (issue #192).',
            },
          },
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              event_id: { type: 'string' },
              symbol: { type: 'string' },
              ledger: { type: 'integer' },
              created_at: { type: 'string', format: 'date-time' },
              resolved_at: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })

    // Issue #168: `?unresolved=true` narrows to records a reindex or replay
    // hasn't repaired yet — the live-problem view; omitting it returns the
    // full history, resolved records included.
    const onlyUnresolved = q.unresolved === 'true'

    // Issue #192: symbol and ledger-range filters, validated with the same
    // helpers /events uses so the two feeds reject the same inputs.
    if (q.symbol !== undefined && (typeof q.symbol !== 'string' || q.symbol.trim() === '')) {
      return reply.code(400).send({ error: 'invalid symbol filter' })
    }
    const symbol = typeof q.symbol === 'string' ? q.symbol.trim() : null
    if (invalidLedgerRange(q.from_ledger, q.to_ledger)) {
      return reply.code(400).send({
        error: 'invalid ledger range: from_ledger/to_ledger must be non-negative integers, from_ledger <= to_ledger, and the range must not exceed 10000 ledgers',
      })
    }
    const fromLedger = ledgerBound(q.from_ledger)
    const toLedger = ledgerBound(q.to_ledger)

    const params: unknown[] = []
    const conditions: string[] = []
    if (onlyUnresolved) {
      conditions.push(`resolved_at IS NULL`)
    }
    if (symbol !== null) {
      params.push(symbol)
      conditions.push(`symbol = $${params.length}`)
    }
    if (fromLedger !== null) {
      params.push(fromLedger)
      conditions.push(`ledger >= $${params.length}`)
    }
    if (toLedger !== null) {
      params.push(toLedger)
      conditions.push(`ledger <= $${params.length}`)
    }
    // The total counts everything the filters match, cursor excluded, so an
    // operator sees the scale of the quarantine without paging to the end.
    const filterWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM failed_events ${filterWhere}`,
      [...params]
    )
    reply.header('X-Total-Count', String(total?.total ?? 0))

    if (before !== null) {
      params.push(before)
      conditions.push(`id < $${params.length}`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)
    const rows = await query<Omit<FailedEventRow, 'error'>>(
      `SELECT id, event_id, symbol, ledger, created_at, resolved_at
         FROM failed_events ${where}
        ORDER BY id DESC LIMIT $${params.length}`,
      params
    )
    return rows
  })

  // --- Re-evaluate a quarantined event (issue #283) ---
  // The middle ground between "leave it quarantined" and `npm run reindex`
  // (which rebuilds every derived table from the entire raw log): re-attempt
  // the fold for exactly this one event, once a contract or decoder fix has
  // shipped, without a maintainer hand-editing `failed_events`/`events` over
  // psql. All the actual logic (advisory-lock coordination with the live
  // poller/reindex, idempotency, updating the existing failed_events row
  // rather than inserting a new one) already lives in
  // `indexer/replay.ts`'s `replayFailedEvent` — added for `npm run
  // replay-failed` (issue #170) — this route is the HTTP door onto it.
  //
  // Same "operator diagnostics, no auth scheme" posture as
  // GET /admin/failed-events above: reachable without authentication, but a
  // still-failing replay's raw exception text is never echoed back (only
  // logged, by replayFailedEvent itself) — mirroring classifyError's rule.
  app.post<{ Params: { id: string } }>('/admin/failed-events/:id/re-evaluate', async (req, reply) => {
    const eventId = req.params.id.trim()
    if (!eventId) return reply.code(400).send({ error: 'invalid event id' })

    // Propagates uncaught on a lock conflict (ReplayLockError carries its
    // own statusCode; classifyError formats it) or any other unexpected
    // throw (falls through to a generic 500, message withheld).
    const outcome = await replayFailedEvent(eventId)
    if (outcome.status === 'still_failing') {
      return reply.code(422).send({ eventId: outcome.eventId, status: outcome.status })
    }
    return { eventId: outcome.eventId, status: outcome.status }
  })

  // Issue #287: resolving quarantined events one at a time via direct SQL
  // doesn't scale once a bad handler/schema change quarantines a batch of
  // them at once. Accepts up to 500 ids per call (matching this codebase's
  // other batch-size ceilings) and only touches rows that are still
  // unresolved — an id that's already resolved, or doesn't exist, is
  // silently excluded from the count rather than erroring the whole batch,
  // since a stale/duplicate id in an admin's list shouldn't block resolving
  // the rest.
  const MAX_BATCH_RESOLVE_IDS = 500
  app.post('/admin/failed-events/batch-resolve', async (req, reply) => {
    const body = req.body as { ids?: unknown; resolution?: unknown; note?: unknown }
    const ids = body.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'ids must be a non-empty array' })
    }
    if (ids.length > MAX_BATCH_RESOLVE_IDS) {
      return reply.code(400).send({ error: `ids must not exceed ${MAX_BATCH_RESOLVE_IDS} entries` })
    }
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return reply.code(400).send({ error: 'ids must all be positive integers' })
    }
    const resolution = body.resolution
    if (resolution !== 'resolved' && resolution !== 'ignored') {
      return reply.code(400).send({ error: "resolution must be 'resolved' or 'ignored'" })
    }
    const note = body.note
    if (note !== undefined && typeof note !== 'string') {
      return reply.code(400).send({ error: 'note must be a string' })
    }

    const resolvedCount = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE failed_events
            SET resolved_at = now(), resolution = $1, resolution_note = $2
          WHERE id = ANY($3::bigint[]) AND resolved_at IS NULL`,
        [resolution, note ?? null, ids]
      )
      return result.rowCount ?? 0
    })

    return { resolved: resolvedCount }
  })

  // --- Admin audit log (issue #291) ---
  // Exposes the immutable admin_audit_log table to authorized maintainers.
  // Authentication is required: only a holder of a valid Stellar signature
  // can read the trail — it contains admin addresses and IP addresses that
  // should not be publicly readable.
  //
  // Pagination follows the same `?before=<id>` cursor pattern as every other
  // list endpoint in this file. `?admin=<G…>` filters to a single operator's
  // actions; `?action=<label>` filters to a single action type.
  app.get('/admin/audit-log', async (req, reply) => {
    // Require authentication — this endpoint surfaces IP addresses and admin
    // identities that are not appropriate for unauthenticated callers.
    const auth = await authenticateRequest(req.headers, nonceStore, undefined, req.log)
    if (!auth.authenticated) {
      return reply.code(auth.status).send({ error: auth.error || 'Authentication required' })
    }

    const q = req.query as Record<string, unknown>
    if (invalidLimit(q.limit)) return reply.code(400).send({ error: 'invalid limit parameter' })
    const l = limit(q.limit)
    const before = cursor(q.before)
    if (invalidCursor(q.before)) return reply.code(400).send({ error: 'invalid before cursor' })

    // Optional filter by admin address.
    if (q.admin !== undefined && q.admin !== '') {
      if (typeof q.admin !== 'string' || !validAddress(q.admin)) {
        return reply.code(400).send({ error: 'invalid Stellar address' })
      }
    }
    // Optional filter by action type — any non-empty string is accepted so
    // future action labels don't require a server deploy to query.
    // An empty `?action=` means "no filter", like every other optional
    // string filter in this file; only a non-string (repeated param) is an error.
    if (q.action !== undefined && typeof q.action !== 'string') {
      return reply.code(400).send({ error: 'invalid action filter' })
    }

    const params: unknown[] = []
    const conditions: string[] = []

    if (before !== null) {
      params.push(before)
      conditions.push(`id < $${params.length}`)
    }
    if (typeof q.admin === 'string' && q.admin) {
      params.push(q.admin)
      conditions.push(`admin_address = $${params.length}`)
    }
    if (typeof q.action === 'string' && q.action.trim()) {
      params.push(q.action.trim())
      conditions.push(`action = $${params.length}`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(l)

    const rows = await query<AdminAuditLogRow>(
      `SELECT id, admin_address, action, ip_address, payload, created_at
         FROM admin_audit_log ${where}
        ORDER BY id DESC LIMIT $${params.length}`,
      params
    )
    return rows
  })

  // --- Aggregate stats (with indexer freshness — issue #2) ---
  //
  // Issue #18: /api/stats is the hottest endpoint (the frontend polls it
  // every 15s from every tab, and proposal enumeration depends on it) and the
  // most expensive (eight uncached counts). A short-lived in-process cache
  // collapses a burst of polls to one set of queries. Scoped to this server
  // instance — a fresh registerRoutes() closure per buildServer() — so it
  // never leaks across tests or restarts.
  let statsCache: { at: number; value: DAOStats } | null = null
  const statsGate = new ConcurrencyGate(Math.max(1, config.http.statsMaxConcurrent))

  async function computeStats(): Promise<DAOStats> {
    const row = await queryOne<{
      total_members: string
      active_members: string
      total_loan_proposals: string
      total_loans: string
      active_loans: string
      defaulted_loans: string
      total_defaulted_value: string | null
      total_treasury_proposals: string
      total_staked: string | null
      total_contribution: string | null
      interest_collected: string | null
      principal_lent: string | null
      principal_repaid: string | null
      value_defaulted: string | null
      quarantined_events: string
      last_ledger: number | null
      observed_tip_ledger: number | null
      cursor_updated_at: string | null
      quarantine_escalated_at: string | null
      reorg_detected_at: string | null
      reorg_contract_id: string | null
      reorg_last_ledger: number | null
      reorg_detail: string | null
    }>(
      // Member counts mirror the contract's two distinct getters:
      // get_total_members (all-time) vs get_active_members (current). Both
      // require a real join event — `joined_ledger IS NOT NULL` — so phantom
      // rows from a name/stake event never count (issue #14). total_staked
      // sums only non-exited members: the `exited` handler now zeroes stake
      // (issue #13), and this WHERE is defence in depth so a future handler
      // gap can't re-inflate the figure.
      `SELECT
         (SELECT count(*) FROM members WHERE joined_ledger IS NOT NULL)             AS total_members,
         (SELECT count(*) FROM members WHERE joined_ledger IS NOT NULL AND exited = false) AS active_members,
         (SELECT count(*) FROM loan_proposals)                                     AS total_loan_proposals,
         (SELECT count(*) FROM loans)                                              AS total_loans,
         (SELECT count(*) FROM loans WHERE status = 'active')                      AS active_loans,
         (SELECT count(*) FROM loans WHERE status = 'defaulted')                   AS defaulted_loans,
         (SELECT COALESCE(sum(outstanding), 0) FROM loans WHERE status = 'defaulted') AS total_defaulted_value,
         (SELECT count(*) FROM treasury_proposals)                                 AS total_treasury_proposals,
         (SELECT COALESCE(sum(stake), 0) FROM members WHERE exited = false)         AS total_staked,
         (SELECT COALESCE(sum(contribution), 0) FROM members WHERE exited = false)  AS total_contribution,
         (SELECT interest_collected FROM dao_totals WHERE id = 1)                  AS interest_collected,
         (SELECT principal_lent     FROM dao_totals WHERE id = 1)                  AS principal_lent,
         (SELECT principal_repaid   FROM dao_totals WHERE id = 1)                  AS principal_repaid,
         (SELECT value_defaulted    FROM dao_totals WHERE id = 1)                  AS value_defaulted,
         (SELECT count(*) FROM failed_events WHERE resolved_at IS NULL)            AS quarantined_events,
         -- Issue #289: indexer_cursor has one row per tailed contract now.
         -- Same "worst row wins" aggregation as /ready — last_ledger,
         -- observed_tip_ledger and cursor_updated_at must come from the
         -- *same* row (the least-recently-updated one) so the freshness
         -- figures derived from them below stay internally consistent,
         -- rather than each column independently picking a different
         -- contract's value.
         (SELECT last_ledger FROM indexer_cursor ORDER BY updated_at ASC NULLS FIRST LIMIT 1) AS last_ledger,
         (SELECT observed_tip_ledger FROM indexer_cursor ORDER BY updated_at ASC NULLS FIRST LIMIT 1) AS observed_tip_ledger,
         (SELECT updated_at FROM indexer_cursor ORDER BY updated_at ASC NULLS FIRST LIMIT 1) AS cursor_updated_at,
         (SELECT escalated_at FROM quarantine_state WHERE id = 1)                  AS quarantine_escalated_at,
         -- Issue #191: the latest uncleared ledger discontinuity, if any.
         (SELECT detected_at FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1) AS reorg_detected_at,
         (SELECT contract_id FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1) AS reorg_contract_id,
         (SELECT last_ledger FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1) AS reorg_last_ledger,
         (SELECT detail FROM reorg_halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1) AS reorg_detail`
    )
    const cursorUpdatedAt = row?.cursor_updated_at
    const secondsSinceUpdate = cursorUpdatedAt
      ? Math.floor((Date.now() - new Date(cursorUpdatedAt).getTime()) / 1000)
      : null
    const isStale = cursorUpdatedAt != null &&
      Date.now() - new Date(cursorUpdatedAt).getTime() > config.indexer.staleAfterMs

    const lastLedger = row?.last_ledger ?? null
    const tipLedger = row?.observed_tip_ledger ?? null
    const ledgersBehind = lastLedger != null && tipLedger != null && tipLedger > lastLedger
      ? tipLedger - lastLedger
      : null
    // Issue #139: same derivation as /ready — a named, configurable constant
    // rather than a bare literal that could silently drift from it.
    const estimatedLagSeconds = ledgersBehind != null
      ? ledgersBehind * config.stellar.ledgerCloseTimeSeconds
      : null

    return {
      totalMembers: Number(row?.total_members ?? 0),
      activeMembers: Number(row?.active_members ?? 0),
      totalLoanProposals: Number(row?.total_loan_proposals ?? 0),
      totalLoans: Number(row?.total_loans ?? 0),
      activeLoans: Number(row?.active_loans ?? 0),
      defaultedLoans: Number(row?.defaulted_loans ?? 0),
      totalDefaultedValue: String(row?.total_defaulted_value ?? '0'),
      totalTreasuryProposals: Number(row?.total_treasury_proposals ?? 0),
      totalStaked: String(row?.total_staked ?? '0'),
      totalContribution: String(row?.total_contribution ?? '0'),
      // Issue #281: guard the zero-contribution case explicitly rather than
      // relying on Number(0n)/Number(0n) — that's NaN, which would silently
      // become `null` over JSON and break any dashboard doing arithmetic on it.
      stakingRatio: (() => {
        const staked = BigInt(row?.total_staked ?? '0')
        const contribution = BigInt(row?.total_contribution ?? '0')
        return contribution === 0n ? 0 : Number(staked) / Number(contribution)
      })(),
      interestCollected: String(row?.interest_collected ?? '0'),
      principalLent: String(row?.principal_lent ?? '0'),
      principalRepaid: String(row?.principal_repaid ?? '0'),
      valueDefaulted: String(row?.value_defaulted ?? '0'),
      quarantinedEvents: Number(row?.quarantined_events ?? 0),
      quarantineEscalatedAt: row?.quarantine_escalated_at ?? null,
      lastIndexedLedger: lastLedger,
      observedTipLedger: tipLedger,
      ledgersBehind,
      estimatedLagSeconds,
      secondsSinceUpdate,
      indexerStale: isStale,
      // Issue #191: a recorded, uncleared ledger discontinuity. Distinct from
      // `indexerStale` — the worker halted on purpose and refuses to resume
      // until an operator clears it (see docs/REORG_RECOVERY.md).
      reorgDetected: row?.reorg_detected_at != null,
      reorgHalt: row?.reorg_detected_at != null
        ? {
            detectedAt: new Date(row.reorg_detected_at).toISOString(),
            contractId: row.reorg_contract_id ?? '',
            lastLedger: row.reorg_last_ledger ?? null,
            detail: row.reorg_detail ?? '',
          }
        : null,
      // Issue #156: live SSE connection count for this process.
      connectedStreams: getConnectedStreamCount(),
      // Issue #169: NOTIFY failures since process start — in-process only,
      // same caveat as connectedStreams above.
      notificationFailures: getNotificationFailureCount(),
    }
  }

  app.get('/stats', async (_req, reply): Promise<DAOStats | { error: string }> => {
    const ttl = config.http.statsCacheMs
    setCachePolicy(reply, 'public-live')
    // Issue #156: connectedStreams is live process state — always refresh it
    // even when the rest of the stats payload is served from the short cache.
    const liveStreams = getConnectedStreamCount()
    if (statsCache && Date.now() - statsCache.at < ttl) {
      return { ...statsCache.value, connectedStreams: liveStreams }
    }

    // Stats is an aggregate over several tables and is the only request type
    // allowed to be shed. A cache miss never waits behind another expensive
    // recomputation: preserving ordinary reads is more useful than making a
    // dashboard poll queue until the request pool is exhausted.
    if (!statsGate.tryAcquire()) {
      reply.header('Retry-After', String(config.http.statsRetryAfterSeconds))
      return reply.code(503).send({ error: 'stats temporarily unavailable; retry shortly' })
    }

    try {
      const value = await computeStats()
      statsCache = { at: Date.now(), value }
      return { ...value, connectedStreams: liveStreams }
    } catch (err) {
      // A successful prior value remains useful during a transient database
      // failure. Surface that it is stale while retaining the normal shape.
      if (statsCache) {
        app.log.warn({ err }, 'stats recompute failed; serving stale cached value')
        reply.header('X-Data-Stale', 'true')
        return { ...statsCache.value, connectedStreams: liveStreams }
      }
      throw err
    } finally {
      statsGate.release()
    }
  })

  app.get('/stats/history', {
    schema: {
      tags: ['Stats'],
      summary: 'Historical daily loan aggregates',
      response: {
        200: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                required: ['date', 'principalLent', 'principalRepaid', 'defaults', 'valueDefaulted', 'cumulativeDefaultRatePercent'],
                properties: {
                  date: { type: 'string', format: 'date' },
                  principalLent: { type: 'string' },
                  principalRepaid: { type: 'string' },
                  defaults: { type: 'integer' },
                  valueDefaulted: { type: 'string' },
                  cumulativeDefaultRatePercent: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_req, reply) => {
    setCachePolicy(reply, 'public-live')
    const cached = await historyCache.get()
    if (cached) return cached

    const rows = await query<{
      day: string
      principal_lent: string
      principal_repaid: string
      defaults_count: number
      value_defaulted: string
      cumulative_originated: string
      cumulative_defaults: string
    }>(
      `WITH bounds AS (
         SELECT min(day) AS first_day, (now() AT TIME ZONE 'UTC')::date AS last_day
           FROM daily_loan_stats
       ), calendar AS (
         SELECT generate_series(first_day, last_day, interval '1 day')::date AS day
           FROM bounds
          WHERE first_day IS NOT NULL
       ), daily AS (
         SELECT day, principal_lent, principal_repaid, defaults_count, value_defaulted,
                loans_originated
           FROM daily_loan_stats
       )
       SELECT calendar.day::text AS day,
              COALESCE(daily.principal_lent, 0)::text AS principal_lent,
              COALESCE(daily.principal_repaid, 0)::text AS principal_repaid,
              COALESCE(daily.defaults_count, 0) AS defaults_count,
              COALESCE(daily.value_defaulted, 0)::text AS value_defaulted,
              SUM(COALESCE(daily.loans_originated, 0)) OVER (ORDER BY calendar.day)::text AS cumulative_originated,
              SUM(COALESCE(daily.defaults_count, 0)) OVER (ORDER BY calendar.day)::text AS cumulative_defaults
         FROM calendar
         LEFT JOIN daily USING (day)
        ORDER BY calendar.day`
    )
    const result = {
      data: rows.map((row) => {
        const originated = Number(row.cumulative_originated)
        const defaults = Number(row.cumulative_defaults)
        return {
          date: row.day,
          principalLent: row.principal_lent,
          principalRepaid: row.principal_repaid,
          defaults: row.defaults_count,
          valueDefaulted: row.value_defaulted,
          cumulativeDefaultRatePercent: originated === 0
            ? 0
            : Number(((defaults / originated) * 100).toFixed(4)),
        }
      }),
    }
    await historyCache.set(result)
    return result
  })
}

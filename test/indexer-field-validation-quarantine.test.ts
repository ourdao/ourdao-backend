// Issue #42 (required-field validation) and issue #43 (the quarantine path a
// FieldValidationError feeds into), tested at the seam between them.
//
// test/indexer-field-validation.test.ts already covers "a missing required
// field throws instead of writing a default" through applyEvent, and
// test/indexer-quarantine-cursor.test.ts already covers "a page that keeps
// failing eventually quarantines". Neither reaches the validators directly or
// pins the *transition* between the two: that a FieldValidationError rolls the
// whole-page transaction back with no partial derived data left behind, that
// the offending event ends up in failed_events exactly once with resolved_at
// still NULL, and that the threshold decision itself is a deterministic
// function of (page, error) rather than of how many times the test called in.
//
// This file adds those three layers:
//   1. the require* validators called directly, with null/undefined and every
//      coercion-shaped value `Number()`/truthiness would otherwise accept;
//   2. the poller's whole-page transaction rollback, including the work done
//      *before* the failing event in the same page;
//   3. the failed_events transition, and the determinism of the counter.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { pool, query, queryOne } from '../src/db/index.js'
import {
  FieldValidationError,
  requireAddr,
  requireAmount,
  requireBool,
  requireId,
} from '../src/indexer/handlers.js'
import { fetchOnce } from '../src/indexer/poller.js'
import type { DecodedEvent } from '../src/stellar/events.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'

// The poller part of this file hands hand-built fixtures to fetchOnce instead
// of real getEvents responses, so decodeEvent is stubbed to identity for the
// whole file. The validator part never calls decodeEvent, and the rest of
// stellar/events.js is left real so EVENT_FIELDS/namedFields keep working.
vi.mock('../src/stellar/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stellar/events.js')>()
  return { ...actual, decodeEvent: (raw: unknown) => raw as DecodedEvent }
})

const getEventsMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
  getLedgerHash: vi.fn().mockResolvedValue('HASH_FOR_LEDGER'),
}))

const CONTRACT = 'CTESTCONTRACT'

/** A well-formed `loan_dflt` with the `penalty` field removed — the canonical
 *  deterministic FieldValidationError, and the one the existing quarantine
 *  test uses. `overrides` lets a test pin `id`, which is what the poller's
 *  page key (and therefore the failure counter) is derived from. */
function malformedDefault(fields: Record<string, unknown> = {}, overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA', ...fields }, overrides)
}

// ---------------------------------------------------------------------------
// 1. The validators, called directly
// ---------------------------------------------------------------------------

// `namedFields` (src/stellar/events.ts) builds `ev.fields` as
// `fields[name] = data[i] ?? null`, so a field the contract never published —
// or one past the end of the data tuple — reaches a validator as `null`, not
// as a missing key. Both are covered below, since a handler's behaviour must
// not depend on which of the two it is handed.
describe('requireAddr: rejects null and non-string values instead of coercing to ""', () => {
  const ev = (member: unknown, includeKey = true) =>
    decodedEvent('joined', includeKey ? { member, fee: '10' } : { fee: '10' })

  it('accepts a non-empty address string', () => {
    expect(requireAddr(ev('GABC'), 'member')).toBe('GABC')
  })

  it('rejects a null field', () => {
    expect(() => requireAddr(ev(null), 'member')).toThrow(FieldValidationError)
  })

  it('rejects a missing key', () => {
    expect(() => requireAddr(ev(undefined, false), 'member')).toThrow(FieldValidationError)
  })

  it('rejects the empty string, which the old addr() helper turned into ""', () => {
    expect(() => requireAddr(ev(''), 'member')).toThrow(FieldValidationError)
  })

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an object', { member: 'GABC' }],
    ['an array', ['GABC']],
    ['NaN', Number.NaN],
  ])('rejects %s rather than stringifying it', (_label, value) => {
    expect(() => requireAddr(ev(value), 'member')).toThrow(FieldValidationError)
  })
})

describe('requireId: rejects null and non-integer values instead of letting Number() coerce', () => {
  const ev = (id: unknown, includeKey = true) =>
    decodedEvent('loan_req', { ...(includeKey ? { id } : {}), borrower: 'GB', amount: '100', total_repayment: '110' })

  it('accepts an integer number and a decimal-integer string', () => {
    // The string form is reachable: toJsonSafe stringifies bigints upstream.
    expect(requireId(ev(7), 'id')).toBe(7)
    expect(requireId(ev('7'), 'id')).toBe(7)
  })

  it('rejects a null field', () => {
    expect(() => requireId(ev(null), 'id')).toThrow(FieldValidationError)
  })

  it('rejects a missing key', () => {
    expect(() => requireId(ev(undefined, false), 'id')).toThrow(FieldValidationError)
  })

  it.each([
    ['a float', 5.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a non-numeric string', 'not-a-number'],
    ['a hex string', '0x10'],
    ['a padded string', ' 7 '],
    ['an empty string', ''],
    ['a negative decimal string', '-3'],
  ])('rejects %s', (_label, value) => {
    expect(() => requireId(ev(value), 'id')).toThrow(FieldValidationError)
  })

  it('does not enforce the u32 range — a negative JS integer id is still accepted', () => {
    // Pinned deliberately, so nobody assumes this is covered. requireId
    // validates *shape* (a finite integer of the right type), not the u32
    // domain: every id in EVENT_FIELDS is a contract u32, so a negative value
    // cannot reach it from a real chain, and widening the check to reject one
    // would be enforcing a domain rule rather than a decoding one. Note the
    // asymmetry below: the *string* '-3' is rejected, because it fails the
    // /^\d+$/ type gate, not because of its sign.
    expect(requireId(ev(-3), 'id')).toBe(-3)
    expect(requireId(ev(0), 'id')).toBe(0)
    expect(() => requireId(ev('-3'), 'id')).toThrow(FieldValidationError)
  })

  // The regression this file exists for. The original gate was
  // `Number.isInteger(Number(v))`, and Number() happily converts all of these
  // into a perfectly valid-looking id — so a malformed event committed a
  // derived row keyed on an id the contract never published. The `coerced`
  // column is the id the old gate would have accepted, and each row asserts
  // that coercion really did happen, so these cases can't silently stop
  // describing the bug they were written for.
  const coercionCases: [string, unknown, number][] = [
    ['true', true, 1],
    ['false', false, 0],
    ['[5]', [5], 5],
    ['[]', [], 0],
    ["['5']", ['5'], 5],
    ['an object with valueOf', { valueOf: () => 5 }, 5],
  ]

  it.each(coercionCases)('rejects %s, which Number() would have turned into a valid id', (_label, value, coerced) => {
    expect(() => requireId(ev(value), 'id')).toThrow(FieldValidationError)
    expect(Number.isInteger(Number(value))).toBe(true)
    expect(Number(value)).toBe(coerced)
  })
})

describe('requireAmount: rejects null and non-decimal-integer values instead of coercing to "0"', () => {
  const ev = (fee: unknown, includeKey = true) =>
    decodedEvent('joined', { member: 'GB', ...(includeKey ? { fee } : {}) })

  it('accepts a decimal-integer string and a finite number', () => {
    expect(requireAmount(ev('100'), 'fee')).toBe('100')
    expect(requireAmount(ev(100), 'fee')).toBe('100')
  })

  it('accepts an i128-magnitude value — the top of the range the NUMERIC(40,0) columns hold', () => {
    // 2^127 - 1, the largest i128. toJsonSafe stringifies it upstream.
    const i128Max = '170141183460469231731687303715884105727'
    expect(requireAmount(ev(i128Max), 'fee')).toBe(i128Max)
  })

  it('rejects a null field', () => {
    expect(() => requireAmount(ev(null), 'fee')).toThrow(FieldValidationError)
  })

  it('rejects a missing key', () => {
    expect(() => requireAmount(ev(undefined, false), 'fee')).toThrow(FieldValidationError)
  })

  it.each([
    ['a negative amount', '-10'],
    ['a negative number', -10],
    ['a float', '1.5'],
    ['a float as a number', 1.5],
    ['a signed-plus string', '+10'],
    ['a hex string', '0x10'],
    ['a padded string', ' 10 '],
    ['an empty string', ''],
    ['a non-numeric string', 'lots'],
    ['a boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, value) => {
    expect(() => requireAmount(ev(value), 'fee')).toThrow(FieldValidationError)
  })

  it('rejects a number large enough for String() to render it in exponential notation', () => {
    // Guards a subtler corruption: String(1e21) is '1e+21', which is not a
    // valid NUMERIC literal. Rejecting it here means such a value can never
    // reach a NUMERIC(40,0) column as a silent string.
    expect(String(1e21)).toBe('1e+21')
    expect(() => requireAmount(ev(1e21), 'fee')).toThrow(FieldValidationError)
  })
})

describe('requireBool: rejects null and non-boolean values instead of falling through to false', () => {
  const ev = (support: unknown, includeKey = true) =>
    decodedEvent('loan_vote', { proposal_id: 2, voter: 'GV', ...(includeKey ? { support } : {}) })

  it('accepts true and false — false is a real vote, not a missing value', () => {
    expect(requireBool(ev(true), 'support')).toBe(true)
    expect(requireBool(ev(false), 'support')).toBe(false)
  })

  it('rejects a null field', () => {
    expect(() => requireBool(ev(null), 'support')).toThrow(FieldValidationError)
  })

  it('rejects a missing key', () => {
    expect(() => requireBool(ev(undefined, false), 'support')).toThrow(FieldValidationError)
  })

  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['an object', {}],
    ['an array', []],
  ])('rejects %s, which would otherwise be read as a vote against', (_label, value) => {
    expect(() => requireBool(ev(value), 'support')).toThrow(FieldValidationError)
  })
})

describe('FieldValidationError', () => {
  it('carries the event id, symbol, failing field, and the offending value', () => {
    // Every validator reads ev.fields/ev.id/ev.symbol and throws before
    // touching a client, so the FieldValidationError surface can be asserted
    // without a database round trip.
    //
    // `penalty: null` is the shape a real event produces: namedFields
    // (src/stellar/events.ts) fills every catalogued name with
    // `data[i] ?? null`, so a field the contract never published arrives as
    // null rather than as a missing key.
    const ev = decodedEvent('loan_dflt', { loan_id: 9, borrower: 'GB', penalty: null })
    let caught: unknown
    try {
      requireAmount(ev, 'penalty')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(FieldValidationError)
    const message = (caught as Error).message
    expect(message).toContain(`event ${ev.id}`)
    expect(message).toContain('(loan_dflt)')
    expect(message).toContain('field "penalty"')
    expect(message).toContain('null')
  })

  it('reports an absent key as undefined rather than dropping the value from the message', () => {
    // The other shape a fixture-built event can have. JSON.stringify(undefined)
    // is undefined, so the message reads "got undefined" — the field and value
    // are still both named, which is what makes the failure diagnosable from
    // failed_events alone.
    const ev = decodedEvent('loan_dflt', { loan_id: 9, borrower: 'GB' })
    expect(() => requireAmount(ev, 'penalty')).toThrow(/field "penalty".*got undefined/)
  })

  it('names the field that actually failed, not just the first one read', () => {
    // loan_req reads id, then borrower, then amount — the message must point
    // at whichever of those the event actually got wrong.
    const badAmount = decodedEvent('loan_req', { id: 1, borrower: 'GB', amount: '-1', total_repayment: '110' })
    expect(() =>
      requireAmount(badAmount, 'amount')
    ).toThrow(/field "amount" must be a non-negative decimal-integer amount, got "-1"/)
  })
})

// ---------------------------------------------------------------------------
// 2 & 3. The poller: rollback, then the quarantine transition
// ---------------------------------------------------------------------------

describe('indexer: a FieldValidationError rolls back the whole page, then quarantines', () => {
  let client: PoolClient

  beforeEach(async () => {
    // poller.ts holds the quarantine escalation counter in module scope
    // (issue #172) and exposes no way to reset it — it only clears when a page
    // folds cleanly or a quarantine run finishes. Drive one empty page through
    // first so every test below starts from a clean counter whatever order the
    // runner picks, then reset the database.
    getEventsMock.mockReset()
    getEventsMock.mockResolvedValue({ events: [], cursor: 'tok-clear', latestLedger: 100_000 })
    await fetchOnce(CONTRACT)
    getEventsMock.mockReset()
    await resetDb()
    client = await pool.connect()
  })

  afterEach(() => client.release())
  afterAll(closeDb)

  it('discards derived work already done earlier in the same page, not just the failing event', async () => {
    // The page is [good, bad, good]. A whole-page transaction means the first
    // `joined` — inserted, marked folded, and notified — is rolled back with
    // the failure. This is the acceptance criterion in its strongest form: no
    // event in a page containing a malformed one may leave derived data behind.
    const good1 = decodedEvent('joined', { member: 'GA', fee: '10' })
    const bad = malformedDefault()
    const good2 = decodedEvent('joined', { member: 'GB', fee: '20' })
    getEventsMock.mockResolvedValue({ events: [good1, bad, good2], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)

    // Nothing at all survived the rollback — not the members written before
    // the failure, not the raw rows, not the notifications.
    expect(await query('SELECT * FROM members')).toHaveLength(0)
    expect(await query('SELECT * FROM events')).toHaveLength(0)
    expect(await query('SELECT * FROM notifications')).toHaveLength(0)

    // No progress is recorded either: the cursor is advanced only after the
    // page commits, so a rolled-back page cannot look like progress.
    expect(await query('SELECT * FROM indexer_cursor')).toHaveLength(0)
  })

  it('repeats the same rollback on each attempt below the threshold, then transitions to failed_events', async () => {
    const good1 = decodedEvent('joined', { member: 'GA', fee: '10' })
    const bad = malformedDefault()
    const good2 = decodedEvent('joined', { member: 'GB', fee: '20' })
    getEventsMock.mockResolvedValue({ events: [good1, bad, good2], cursor: 'tok', latestLedger: 100_000 })

    // Threshold is 3 (INDEXER_QUARANTINE_AFTER_FAILURES): the first two
    // attempts are still treated as possibly-transient and rethrown.
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)
    for (const attempt of [1, 2]) {
      expect(await query('SELECT * FROM members'), `attempt ${attempt}`).toHaveLength(0)
      expect(await query('SELECT * FROM failed_events'), `attempt ${attempt}`).toHaveLength(0)
    }

    // Third identical failure on the same page — the counter trips.
    await expect(fetchOnce(CONTRACT)).resolves.toBeUndefined()

    // The two well-formed events folded; the malformed one did not.
    const members = await query<{ address: string; contribution: string }>(
      'SELECT address, contribution FROM members ORDER BY address'
    )
    expect(members).toEqual([
      { address: 'GA', contribution: '10' },
      { address: 'GB', contribution: '20' },
    ])

    // The offending event is recorded in failed_events: one row, still
    // unresolved, carrying the exact validation error.
    const failed = await query<{ event_id: string; symbol: string; ledger: number; error: string; resolved_at: string | null }>(
      'SELECT event_id, symbol, ledger, error, resolved_at FROM failed_events'
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ event_id: bad.id, symbol: 'loan_dflt', ledger: bad.ledger })
    expect(failed[0]?.error).toMatch(/field "penalty"/)
    // resolved_at stays NULL until a reindex or replay-failed re-folds it —
    // this is a live problem, not a historical one (issue #168).
    expect(failed[0]?.resolved_at).toBeNull()

    // The append-only raw log is intact for all three, and the quarantined
    // row is explicitly *not* folded, so `insertRawEvent`'s folded_at check
    // retries it rather than treating the row as done (issue #119).
    const raw = await query<{ id: string; folded_at: string | null }>('SELECT id, folded_at FROM events ORDER BY id')
    expect(raw.map((r) => r.id).sort()).toEqual([good1.id, bad.id, good2.id].sort())
    expect(raw.find((r) => r.id === bad.id)?.folded_at).toBeNull()
    expect(raw.find((r) => r.id === good1.id)?.folded_at).not.toBeNull()

    // And indexing continued past it.
    const cursor = await queryOne<{ paging_token: string }>(
      'SELECT paging_token FROM indexer_cursor WHERE contract_id = $1',
      [CONTRACT]
    )
    expect(cursor?.paging_token).toBe(good2.id)
  })

  it('records one failed_events row per event however many times the page is retried', async () => {
    const bad = malformedDefault()
    getEventsMock.mockResolvedValue({ events: [bad], cursor: 'tok', latestLedger: 100_000 })

    // Drive the counter past the threshold, then past it again: a second
    // quarantine cycle re-folds the same failing event and must update the
    // existing row rather than accumulate duplicates (issue #171, UNIQUE on
    // event_id).
    for (let i = 0; i < 6; i++) {
      await fetchOnce(CONTRACT).catch(() => undefined)
    }

    const failed = await query<{ event_id: string }>('SELECT event_id FROM failed_events')
    expect(failed).toEqual([{ event_id: bad.id }])

    // Repeated folds of the well-formed neighbours stay idempotent — the
    // already-folded events are skipped via folded_at, so no derived row is
    // written twice.
    const good = decodedEvent('joined', { member: 'GA', fee: '10' })
    getEventsMock.mockResolvedValue({ events: [good, bad], cursor: 'tok2', latestLedger: 100_000 })
    for (let i = 0; i < 3; i++) {
      await fetchOnce(CONTRACT).catch(() => undefined)
    }
    expect(await query('SELECT * FROM members')).toHaveLength(1)
    expect(await query('SELECT * FROM failed_events')).toHaveLength(1)
  })
})

describe('indexer: the quarantine threshold is a deterministic function of (page, error)', () => {
  beforeEach(async () => {
    getEventsMock.mockReset()
    getEventsMock.mockResolvedValue({ events: [], cursor: 'tok-clear', latestLedger: 100_000 })
    await fetchOnce(CONTRACT)
    getEventsMock.mockReset()
    await resetDb()
  })
  afterAll(closeDb)

  it('does not trip on a changed error message, even on the same page', async () => {
    // Identical first/last ids and length, so the page key is the same; only
    // the failing field differs. The counter must restart rather than carry
    // two unrelated failures into a spurious quarantine.
    const id = '900-0'
    const pageA = [decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' }, { id })]
    const pageB = [decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA', penalty: '-1' }, { id })]

    getEventsMock.mockResolvedValueOnce({ events: pageA, cursor: 'tok', latestLedger: 100_000 })
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(/field "penalty"/)

    getEventsMock.mockResolvedValueOnce({ events: pageB, cursor: 'tok', latestLedger: 100_000 })
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(/must be a non-negative/)

    // Third failure, but back to page A's error — a different error from the
    // one the counter is currently holding, so it restarts at 1 and rethrows.
    getEventsMock.mockResolvedValueOnce({ events: pageA, cursor: 'tok', latestLedger: 100_000 })
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(/field "penalty"/)

    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
  })

  it('does not trip on a changed page, even with the same error message', async () => {
    const pageOne = [decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' }, { id: '800-0' })]
    const pageTwo = [decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GA' }, { id: '810-0' })]

    // Same missing `penalty` field, so the same error text — but the poller
    // has moved on to a different page, which means a different cause.
    getEventsMock.mockResolvedValueOnce({ events: pageOne, cursor: 'tok', latestLedger: 100_000 })
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)
    getEventsMock.mockResolvedValueOnce({ events: pageTwo, cursor: 'tok2', latestLedger: 100_000 })
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)
    getEventsMock.mockResolvedValueOnce({ events: pageOne, cursor: 'tok3', latestLedger: 100_000 })
    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)

    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)
  })

  it('trips on the third identical (page, error) and not before', async () => {
    const bad = malformedDefault()
    getEventsMock.mockResolvedValue({ events: [bad], cursor: 'tok', latestLedger: 100_000 })

    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)

    await expect(fetchOnce(CONTRACT)).rejects.toThrow(FieldValidationError)
    expect(await query('SELECT * FROM failed_events')).toHaveLength(0)

    await expect(fetchOnce(CONTRACT)).resolves.toBeUndefined()
    expect(await query('SELECT * FROM failed_events')).toHaveLength(1)
  })
})

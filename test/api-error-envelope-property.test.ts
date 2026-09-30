import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { classifyError } from '../src/api/errors.js'
import { pool } from '../src/db/index.js'
import { resetDb, closeDb } from './db.js'

/**
 * Issue #205: property-style tests asserting the error envelope never leaks
 * Postgres driver details (SQLSTATE, constraint names, table names, column
 * types, etc.) across a representative set of error classes.
 *
 * The existing test/api-error-envelope.test.ts covers specific mapped cases.
 * This file proves the *property*: that for ANY Postgres error, the response
 * body never contains driver-supplied detail, and that withheld detail does
 * reach the log with a matching correlation ID.
 */

// Patterns that indicate Postgres driver details leaked into the response
const PG_LEAK_PATTERNS = [
  /invalid input syntax/i,
  /out of range/i,
  /for type integer/i,
  /for type numeric/i,
  /violates .*constraint "/i,
  /constraint "/i,
  /relation "/i,
  /column "/i,
  /SELECT /,
  /FROM /,
  /INSERT /,
  /UPDATE /,
  /DELETE /,
  /WHERE /,
  /SQLSTATE/i,
  /\b[0-9A-Z]{5}\b/, // SQLSTATE codes like 22P02, 23505
  /pg\./i, // pg.* references
  /postgres/i,
  /\.ts:\d+/, // Stack trace file:line references
  /_pkey/,
  /_fkey/,
  /_check/,
  /_not_null/,
  /schema/i,
]

function containsPgDetail(text: string): boolean {
  return PG_LEAK_PATTERNS.some((pattern) => pattern.test(text))
}

describe('Error envelope property: no Postgres detail leakage (#205)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(closeDb)

  describe('classifyError never returns pg detail in the error field', () => {
    // Representative sample of SQLSTATE codes across different error classes
    const testCases: Array<{
      name: string
      code: string
      expectedStatus: number
      message: string
    }> = [
      // Class 08: Connection exceptions
      { name: 'connection failure', code: '08006', expectedStatus: 503, message: 'connection to server was lost' },
      { name: 'cannot connect now', code: '57P03', expectedStatus: 503, message: 'the database system is shutting down' },
      
      // Class 23: Integrity constraint violations (mapped)
      { name: 'unique violation', code: '23505', expectedStatus: 409, message: 'duplicate key value violates unique constraint "loans_pkey"' },
      { name: 'foreign key violation', code: '23503', expectedStatus: 409, message: 'insert or update on table "votes" violates foreign key constraint "votes_member_id_fkey"' },
      { name: 'check violation', code: '23514', expectedStatus: 422, message: 'new row for relation "loans" violates check constraint "loans_amount_check"' },
      { name: 'not null violation', code: '23502', expectedStatus: 422, message: 'null value in column "member_id" violates not-null constraint' },
      
      // Class 22: Data exceptions (unmapped — should collapse to 500)
      { name: 'invalid text representation', code: '22P02', expectedStatus: 500, message: 'invalid input syntax for type integer: "abc"' },
      { name: 'numeric overflow', code: '22003', expectedStatus: 500, message: 'integer out of range for type integer' },
      { name: 'division by zero', code: '22012', expectedStatus: 500, message: 'division by zero' },
      { name: 'invalid datetime format', code: '22007', expectedStatus: 500, message: 'invalid input syntax for type timestamp' },
      
      // Class 42: Syntax error or access rule violations
      { name: 'undefined table', code: '42P01', expectedStatus: 500, message: 'relation "nonexistent_table" does not exist' },
      { name: 'undefined column', code: '42703', expectedStatus: 500, message: 'column "bad_column" does not exist' },
      
      // Connection-level errors (no SQLSTATE yet, Node errno instead)
      { name: 'connection refused', code: 'ECONNREFUSED', expectedStatus: 503, message: 'connect ECONNREFUSED 127.0.0.1:5432' },
      { name: 'connection reset', code: 'ECONNRESET', expectedStatus: 503, message: 'read ECONNRESET' },
      { name: 'timeout', code: 'ETIMEDOUT', expectedStatus: 503, message: 'connect ETIMEDOUT' },
    ]

    for (const { name, code, expectedStatus, message } of testCases) {
      it(`${name} (${code}): response is generic, detail is withheld`, () => {
        const pgError = Object.assign(new Error(message), {
          code,
          detail: 'Key (member_id)=(GTEST) already exists.',
          constraint: 'members_pkey',
          table: 'members',
          schema: 'public',
        })

        const result = classifyError(pgError)

        expect(result.status).toBe(expectedStatus)
        expect(result.leak).toBe(true) // Marked for logging

        // The error string returned to the client MUST NOT contain any pg detail
        expect(containsPgDetail(result.error)).toBe(false)
        expect(result.error).not.toContain(message)
        expect(result.error).not.toContain('member_id')
        expect(result.error).not.toContain('members_pkey')
        expect(result.error).not.toContain('GTEST')
      })
    }

    it('unmapped SQLSTATE collapses to generic 500', () => {
      // Any five-character SQLSTATE we haven't explicitly mapped should
      // return a generic 500 with no detail
      const unknownCodes = ['12345', '99Z99', '00AAA', '54000', '53000']

      for (const code of unknownCodes) {
        const err = Object.assign(new Error(`database error with code ${code}`), {
          code,
          detail: 'sensitive internal detail',
          table: 'secret_table',
        })

        const result = classifyError(err)

        expect(result.status).toBe(500)
        expect(result.error).toBe('internal server error')
        expect(result.leak).toBe(true)
        expect(containsPgDetail(result.error)).toBe(false)
      }
    })

    it('non-pg exception with revealing message: withheld', () => {
      const err = new Error('Failed to connect to database at postgres://user:password@localhost:5432/db')

      const result = classifyError(err)

      expect(result.status).toBe(500)
      expect(result.error).toBe('internal server error')
      expect(result.leak).toBe(true)
      expect(result.error).not.toContain('password')
      expect(result.error).not.toContain('user')
    })

    it('deliberate 4xx exceptions: message is kept', () => {
      const err = Object.assign(new Error('field x is required'), { statusCode: 400 })

      const result = classifyError(err)

      expect(result.status).toBe(400)
      expect(result.error).toBe('field x is required')
      expect(result.leak).toBe(false) // Not leaked, message was deliberate
    })
  })

  describe('End-to-end: response bodies never contain pg detail', () => {
    it('a real pg error in a route handler returns safe envelope', async () => {
      // Trigger a numeric overflow (22003) via a query parameter
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents?kind=loan&proposal_id=99999999999999999',
      })

      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({
        error: 'internal server error',
        code: expect.any(String),
        correlationId: expect.any(String),
      })

      // The response body must not contain any pg detail
      expect(containsPgDetail(res.payload)).toBe(false)
    })

    it('404 handler returns the standard envelope with no pg detail', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/nonexistent-route-12345',
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({
        error: 'route not found',
        code: expect.any(String),
        correlationId: expect.any(String),
      })

      expect(containsPgDetail(res.payload)).toBe(false)
    })

    it('validation errors do not leak pg detail', async () => {
      // Send a malformed request that fails schema validation
      const res = await app.inject({
        method: 'GET',
        url: '/api/loans/not-a-number',
      })

      expect(res.statusCode).toBe(400)
      expect(containsPgDetail(res.payload)).toBe(false)
    })
  })

  describe('Withheld detail reaches the log with correlation ID', () => {
    it('pg error detail is logged with the same correlation id as the response', async () => {
      const lines: string[] = []
      const capturing = await buildServer({
        logger: {
          level: 'error',
          stream: { write: (s: string) => void lines.push(s) },
        },
      })
      await capturing.ready()

      try {
        const res = await capturing.inject({
          method: 'GET',
          url: '/api/documents?kind=loan&proposal_id=99999999999999999',
        })

        const correlationId = res.json().correlationId as string
        expect(correlationId).toBeTruthy()

        // Find the log line with this correlation id
        const logLine = lines.find((l) => l.includes(correlationId))
        expect(logLine, 'log line with correlation id should exist').toBeTruthy()

        // The log line SHOULD contain the pg detail (it's withheld from the client, not the log)
        expect(logLine).toMatch(/out of range|22003|numeric/i)

        // But the response body must not
        expect(containsPgDetail(res.payload)).toBe(false)
      } finally {
        await capturing.close()
      }
    })

    it('mapped pg error (unique violation): client sees generic, log sees detail', async () => {
      const lines: string[] = []
      const capturing = await buildServer({
        logger: {
          level: 'error',
          stream: { write: (s: string) => void lines.push(s) },
        },
      })
      await capturing.ready()

      try {
        // Force a unique violation by mocking
        const err = Object.assign(
          new Error('duplicate key value violates unique constraint "members_pkey"'),
          {
            code: '23505',
            detail: 'Key (member_id)=(GTEST) already exists.',
            constraint: 'members_pkey',
            table: 'members',
          }
        )
        const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(err)

        try {
          const res = await capturing.inject({
            method: 'GET',
            url: '/api/members',
          })

          expect(res.statusCode).toBe(409)
          expect(res.json().error).toBe('resource already exists') // Generic message
          expect(containsPgDetail(res.payload)).toBe(false)

          const correlationId = res.json().correlationId as string
          const logLine = lines.find((l) => l.includes(correlationId))
          expect(logLine, 'log should have correlation id').toBeTruthy()

          // Log should contain the constraint name and detail
          expect(logLine).toMatch(/members_pkey|23505/)
        } finally {
          spy.mockRestore()
        }
      } finally {
        await capturing.close()
      }
    })
  })

  describe('Structural exhaustiveness: new unclassified branches fail', () => {
    it('adding a new pg error class without updating classifyError is caught', () => {
      // This test documents the current behavior: any SQLSTATE matching /^[0-9A-Z]{5}$/
      // that isn't explicitly mapped falls through to generic 500.
      //
      // If a new error class is added (e.g., class 25 for transaction state),
      // and classifyError isn't updated, this test ensures it collapses to
      // generic 500 with leak=true, rather than leaking the message.

      const newClass = '25P02' // example: invalid transaction termination
      const err = Object.assign(
        new Error('current transaction is aborted, commands ignored until end of transaction block'),
        { code: newClass }
      )

      const result = classifyError(err)

      // Should be generic 500, not the message
      expect(result.status).toBe(500)
      expect(result.error).toBe('internal server error')
      expect(result.leak).toBe(true)
    })
  })
})

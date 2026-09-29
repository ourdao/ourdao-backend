import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import type { Socket } from 'node:net'

/**
 * Stable, machine-readable error codes (issue #186). Clients branch on these,
 * never on the `error` text, which may be reworded at any time.
 *
 * Append-only, like ourdao-contracts' error variants: never rename, remove or
 * repurpose a code — add a new one. Every code is documented in the README's
 * "Errors" section.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'REQUEST_TIMEOUT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CLIENT_ERROR',
  'RESOURCE_ALREADY_EXISTS',
  'RELATED_DATA_CONFLICT',
  'CONSTRAINT_VIOLATION',
  'MISSING_REQUIRED_VALUE',
  'DATABASE_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * The single error envelope every failure response uses (issue #81).
 *
 * `error` is a short, safe, human-readable string — the same `{ error: string }`
 * shape the route handlers already return for their deliberate 4xx responses,
 * so existing clients keep working. `code` is the stable machine-readable
 * cause (issue #186). `correlationId` is the Fastify request id: it is echoed
 * in the `x-correlation-id` response header and printed (as `reqId`) on the
 * server-side log line for the same request, so a user-reported failure can
 * be traced to its log entry.
 */
export interface ErrorEnvelope {
  error: string
  code: ErrorCode
  correlationId: string
}

function isErrorCode(value: unknown): value is ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(value)
}

/**
 * The code for a response that only knows its status — a route's deliberate
 * `reply.code(4xx).send({ error })`, a plugin's error, a thrown `statusCode`.
 */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400: return 'BAD_REQUEST'
    case 401: return 'UNAUTHORIZED'
    case 403: return 'FORBIDDEN'
    case 404: return 'NOT_FOUND'
    case 408: return 'REQUEST_TIMEOUT'
    case 413: return 'PAYLOAD_TOO_LARGE'
    case 429: return 'RATE_LIMITED'
    case 503: return 'SERVICE_UNAVAILABLE'
    default: return status >= 400 && status < 500 ? 'CLIENT_ERROR' : 'INTERNAL_ERROR'
  }
}

// Postgres surfaces a failure as a five-character SQLSTATE on `err.code`. A few
// of them map to a meaningful HTTP status; the driver's `message`/`detail`
// (which name columns, constraints and types) is never put in a response — only
// logged. Everything else with a SQLSTATE is an unexpected internal failure and
// collapses to a generic 500.
const PG_STATUS: Record<string, { status: number; error: string; code: ErrorCode }> = {
  '23505': { status: 409, error: 'resource already exists', code: 'RESOURCE_ALREADY_EXISTS' }, // unique_violation
  '23503': { status: 409, error: 'request conflicts with related data', code: 'RELATED_DATA_CONFLICT' }, // foreign_key_violation
  '23514': { status: 422, error: 'request violates a data constraint', code: 'CONSTRAINT_VIOLATION' }, // check_violation
  '23502': { status: 422, error: 'request is missing a required value', code: 'MISSING_REQUIRED_VALUE' }, // not_null_violation
}

// Connection-level failures: the database is unreachable or shutting down.
// SQLSTATE class 08 and a handful of operational codes, plus the Node socket
// errnos `pg` re-throws before a SQLSTATE ever exists.
const PG_CONNECTION_CODES = new Set([
  '08000', '08003', '08006', '08001', '08004', '08007', '08P01',
  '57P01', '57P02', '57P03', '53300',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE',
])

interface MaybePgError {
  code?: string
  detail?: string
  constraint?: string
  table?: string
  schema?: string
}

/**
 * Decide the HTTP status and the client-facing message for a thrown error.
 * `leak` is true when the original error carried detail we withheld from the
 * client (every 5xx, every mapped pg error) and must therefore be logged in
 * full server-side.
 *
 * Exported for direct unit testing of the pg-error mapping.
 */
export function classifyError(err: unknown): { status: number; error: string; code: ErrorCode; leak: boolean } {
  const e = (err ?? {}) as FastifyError & MaybePgError

  // 1. Fastify schema-validation errors. Until issue #55 gives these their own
  //    schema-driven response, they arrive here — the message names the
  //    offending field and is safe and useful, so keep it; only the envelope
  //    is normalised.
  if (e.validation) {
    return { status: e.statusCode ?? 400, error: e.message, code: 'VALIDATION_FAILED', leak: false }
  }

  // 2. Postgres driver errors — map a known SQLSTATE, never surface its text.
  const code = e.code
  if (code && PG_CONNECTION_CODES.has(code)) {
    return { status: 503, error: 'database temporarily unavailable', code: 'DATABASE_UNAVAILABLE', leak: true }
  }
  if (code && PG_STATUS[code]) {
    return { ...PG_STATUS[code], leak: true }
  }
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    // Any other SQLSTATE (e.g. 22P02 invalid_text_representation, 22003 numeric
    // overflow) is a real internal failure — the message describes the schema.
    return { status: 500, error: 'internal server error', code: 'INTERNAL_ERROR', leak: true }
  }

  // 3. A deliberate non-pg error that already chose a 4xx status (an explicit
  //    `throw` with `statusCode`, a plugin error). Its message was chosen on
  //    purpose — keep it.
  const status = e.statusCode ?? 500
  if (status >= 400 && status < 500) {
    return { status, error: e.message || 'bad request', code: codeForStatus(status), leak: false }
  }

  // 4. Everything else is a 5xx. Never echo the message.
  const status5xx = status >= 500 && status <= 599 ? status : 500
  return { status: status5xx, error: 'internal server error', code: codeForStatus(status5xx), leak: true }
}

/**
 * Install the single error handler and 404 handler on a Fastify instance.
 * Call this before routes are registered so every child context inherits it —
 * there is otherwise no `setErrorHandler` in the codebase and every unhandled
 * throw takes Fastify's default path, which echoes the exception message
 * (including raw Postgres text) in 5xx responses.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  // Always expose the request id, on success and failure alike, so a client
  // can quote it even when the body isn't the error envelope.
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-correlation-id', req.id)
    done()
  })

  // Unmatched routes get the same envelope as everything else.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'route not found', code: 'ROUTE_NOT_FOUND', correlationId: req.id } satisfies ErrorEnvelope)
  })

  // Routes answer their deliberate 4xx/5xx with a bare `{ error }` (and the
  // rate limiter with its own body). Stamp every such object with a status-
  // derived `code` and the `correlationId` here, once, so no failure response
  // can leave without them (issue #186). A body that already chose its code
  // (the handlers above) keeps it; any other `code` (a plugin's own, say)
  // is replaced so only documented codes ever reach a client.
  app.addHook('preSerialization', async (req, reply, payload) => {
    if (reply.statusCode < 400 || payload === null || typeof payload !== 'object') return payload
    const body = payload as Record<string, unknown>
    if (typeof body.error !== 'string') return payload
    const code = isErrorCode(body.code) ? body.code : codeForStatus(reply.statusCode)
    return { ...body, code, correlationId: body.correlationId ?? req.id }
  })

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const { status, error, code, leak } = classifyError(err)

    if (leak || status >= 500) {
      // Log with full detail — the log line carries `reqId`, the same value as
      // the response's `correlationId`.
      const pg = err as MaybePgError
      req.log.error(
        {
          err,
          statusCode: status,
          ...(pg.code
            ? { pg: { code: pg.code, detail: pg.detail, constraint: pg.constraint, table: pg.table } }
            : {}),
        },
        `request failed: ${err.message}`
      )
    } else {
      req.log.info({ statusCode: status }, `request rejected: ${error}`)
    }

    reply.code(status).send({ error, code, correlationId: req.id } satisfies ErrorEnvelope)
  })
}

/**
 * Fastify `clientErrorHandler`: answers failures Node detects before a request
 * ever reaches Fastify — a request not received within `requestTimeout`
 * (408), oversized headers (431), a malformed request (400) — with the same
 * envelope as everything else (issues #186, #187). Otherwise mirrors
 * Fastify's default handler. There is no request yet, so the correlation id
 * is minted here and logged alongside the error.
 */
export function clientErrorHandler(this: FastifyInstance, err: NodeJS.ErrnoException, socket: Socket): void {
  if (err.code === 'ECONNRESET' || socket.destroyed) return
  const status = err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400
  const correlationId = randomUUID()
  const envelope: ErrorEnvelope = { error: STATUS_CODES[status]!, code: codeForStatus(status), correlationId }
  const body = JSON.stringify(envelope)
  this.log.debug({ err, correlationId, statusCode: status }, 'client error before request dispatch')
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Content-Type: application/json\r\nConnection: close\r\n\r\n${body}`
    )
  }
  socket.destroy(err)
}

/**
 * Fastify `frameworkErrors`: router-level rejections (a path parameter over
 * `maxParamLength` → 414, a malformed URL → 400) otherwise bypass every hook
 * and are written raw by Fastify, without `code` or `correlationId`. Hooks
 * don't run on this path either, so the envelope is built here in full
 * (issues #186, #187).
 */
export function frameworkErrors(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  const status = err.statusCode ?? 400
  reply
    .code(status)
    .header('x-correlation-id', req.id)
    .send({ error: STATUS_CODES[status] ?? 'Bad Request', code: codeForStatus(status), correlationId: req.id } satisfies ErrorEnvelope)
}

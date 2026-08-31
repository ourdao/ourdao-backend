import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * The single error envelope every failure response uses (issue #81).
 *
 * `error` is a short, safe, human-readable string — the same `{ error: string }`
 * shape the route handlers already return for their deliberate 4xx responses,
 * so existing clients keep working. `correlationId` is the Fastify request id:
 * it is echoed in the `x-correlation-id` response header and printed (as
 * `reqId`) on the server-side log line for the same request, so a user-reported
 * failure can be traced to its log entry.
 */
export interface ErrorEnvelope {
  error: string
  correlationId: string
}

// Postgres surfaces a failure as a five-character SQLSTATE on `err.code`. A few
// of them map to a meaningful HTTP status; the driver's `message`/`detail`
// (which name columns, constraints and types) is never put in a response — only
// logged. Everything else with a SQLSTATE is an unexpected internal failure and
// collapses to a generic 500.
const PG_STATUS: Record<string, { status: number; error: string }> = {
  '23505': { status: 409, error: 'resource already exists' }, // unique_violation
  '23503': { status: 409, error: 'request conflicts with related data' }, // foreign_key_violation
  '23514': { status: 422, error: 'request violates a data constraint' }, // check_violation
  '23502': { status: 422, error: 'request is missing a required value' }, // not_null_violation
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
export function classifyError(err: unknown): { status: number; error: string; leak: boolean } {
  const e = (err ?? {}) as FastifyError & MaybePgError

  // 1. Fastify schema-validation errors. Until issue #55 gives these their own
  //    schema-driven response, they arrive here — the message names the
  //    offending field and is safe and useful, so keep it; only the envelope
  //    is normalised.
  if (e.validation) {
    return { status: e.statusCode ?? 400, error: e.message, leak: false }
  }

  // 2. Postgres driver errors — map a known SQLSTATE, never surface its text.
  const code = e.code
  if (code && PG_CONNECTION_CODES.has(code)) {
    return { status: 503, error: 'database temporarily unavailable', leak: true }
  }
  if (code && PG_STATUS[code]) {
    return { ...PG_STATUS[code], leak: true }
  }
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    // Any other SQLSTATE (e.g. 22P02 invalid_text_representation, 22003 numeric
    // overflow) is a real internal failure — the message describes the schema.
    return { status: 500, error: 'internal server error', leak: true }
  }

  // 3. A deliberate non-pg error that already chose a 4xx status (an explicit
  //    `throw` with `statusCode`, a plugin error). Its message was chosen on
  //    purpose — keep it.
  const status = e.statusCode ?? 500
  if (status >= 400 && status < 500) {
    return { status, error: e.message || 'bad request', leak: false }
  }

  // 4. Everything else is a 5xx. Never echo the message.
  return { status: status >= 500 && status <= 599 ? status : 500, error: 'internal server error', leak: true }
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
    reply.code(404).send({ error: 'route not found', correlationId: req.id } satisfies ErrorEnvelope)
  })

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const { status, error, leak } = classifyError(err)

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

    reply.code(status).send({ error, correlationId: req.id } satisfies ErrorEnvelope)
  })
}

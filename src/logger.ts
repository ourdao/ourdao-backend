// A minimal structured logger for code paths that run outside a Fastify
// request (the indexer worker, the shared stream listener) and so have no
// `request.log` to write through — the same problem src/auth.ts's
// `AuthLogger` solves for request-scoped code (issue #132).
//
// Every line is one JSON object (level, msg, time, and caller-supplied
// fields) rather than a hand-formatted string, so a log aggregator can
// filter/query on `channel`, `eventId`, etc. instead of grepping message
// text. There is no `LOG_LEVEL` gate here (see README's note on the indexer
// worker's logging) — every call is emitted.
export interface StructuredLogger {
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

function emit(level: 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields })
  if (level === 'error') console.error(line)
  else console.warn(line)
}

export const logger: StructuredLogger = {
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
}

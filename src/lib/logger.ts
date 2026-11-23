// Structured logger for code paths outside a Fastify request — the CLI
// entrypoints (reindex, replay) and the indexer's cursor writer. Requests go
// through Fastify/Pino; these paths have no `request.log`, so they emit one
// JSON object per line instead of a hand-formatted string. That keeps a
// terminal-watching operator's view unchanged (`msg` still reads like the old
// line) while making every field machine-queryable in a log aggregator.
//
// There is no LOG_LEVEL gate, matching the indexer worker's existing
// behaviour: every call is emitted.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface StructuredLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger: StructuredLogger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
}

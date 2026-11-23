import { randomBytes } from 'node:crypto'

// Opt-in tracing for the parts of the service that don't run inside a Fastify
// request (the indexer) and for the API process itself (issue #530).
//
// Tracing is OFF unless OTEL_ENABLED=true. With tracing off, getTracer()
// returns a shared no-op tracer: startSpan() allocates nothing and span
// methods do nothing, so the common case pays no per-request cost. When it is
// on, every span that ends is handed to the configured sink as one OpenTelemetry-
// shaped record (trace/span/parent ids, unix-nano start/end, attributes,
// status, duration), which the default sink writes as a single JSON log line
// for a collector to pick up.

export type SpanStatusCode = 'UNSET' | 'OK' | 'ERROR'
export type SpanAttributeValue = string | number | boolean | undefined
export type SpanAttributes = Record<string, SpanAttributeValue>

export interface SpanException {
  type: string
  message: string
  stack?: string
}

export interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  durationMs: number
  attributes: Record<string, string | number | boolean>
  statusCode: SpanStatusCode
  statusMessage?: string
  exception?: SpanException
}

export interface Span {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  setAttribute(key: string, value: SpanAttributeValue): Span
  setAttributes(attributes: SpanAttributes): Span
  setStatus(code: SpanStatusCode, message?: string): Span
  recordException(error: unknown): Span
  end(): void
}

export interface StartSpanOptions {
  /** Parent span, so a child query span links to its request span. */
  parent?: Span | null
  attributes?: SpanAttributes
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span
}

export interface InitTelemetryOptions {
  /** Override the OTEL_ENABLED environment flag (tests). */
  enabled?: boolean
  /** Collect finished spans instead of writing them to stdout (tests). */
  onSpanEnd?: (record: SpanRecord) => void
}

class NoopSpan implements Span {
  readonly name = ''
  readonly traceId = ''
  readonly spanId = ''
  readonly parentSpanId = null
  setAttribute(): Span {
    return this
  }
  setAttributes(): Span {
    return this
  }
  setStatus(): Span {
    return this
  }
  recordException(): Span {
    return this
  }
  end(): void {
    /* tracing disabled — deliberately does nothing */
  }
}

const NOOP_SPAN = new NoopSpan()
const NOOP_TRACER: Tracer = { startSpan: () => NOOP_SPAN }

function flagEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1'
}

function defaultSink(record: SpanRecord): void {
  console.log(
    JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      msg: `[otel] span ${record.name}`,
      ...record,
    })
  )
}

let enabled = flagEnabled(process.env.OTEL_ENABLED)
let sink: (record: SpanRecord) => void = defaultSink

class LiveSpan implements Span {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  private readonly startNs = process.hrtime.bigint()
  private readonly attributes: Record<string, string | number | boolean> = {}
  private statusCode: SpanStatusCode = 'UNSET'
  private statusMessage: string | undefined
  private exception: SpanException | undefined
  private ended = false

  constructor(readonly name: string, parent: Span | null | undefined, attributes?: SpanAttributes) {
    this.traceId = parent?.traceId || randomBytes(16).toString('hex')
    this.spanId = randomBytes(8).toString('hex')
    this.parentSpanId = parent?.spanId || null
    this.setAttributes(attributes)
  }

  setAttribute(key: string, value: SpanAttributeValue): Span {
    if (value !== undefined) this.attributes[key] = value
    return this
  }

  setAttributes(attributes: SpanAttributes | undefined): Span {
    if (!attributes) return this
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value)
    return this
  }

  setStatus(code: SpanStatusCode, message?: string): Span {
    this.statusCode = code
    if (message !== undefined) this.statusMessage = message
    return this
  }

  recordException(error: unknown): Span {
    const err = error instanceof Error ? error : new Error(String(error))
    this.exception = { type: err.name, message: err.message, stack: err.stack }
    return this
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const endNs = process.hrtime.bigint()
    const record: SpanRecord = {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTimeUnixNano: this.startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      durationMs: Number(endNs - this.startNs) / 1e6,
      attributes: { ...this.attributes },
      statusCode: this.statusCode,
    }
    if (this.statusMessage !== undefined) record.statusMessage = this.statusMessage
    if (this.exception !== undefined) record.exception = this.exception
    sink(record)
  }
}

const LIVE_TRACER: Tracer = {
  startSpan: (name, options) => new LiveSpan(name, options?.parent, options?.attributes),
}

/** Read OTEL_ENABLED (and optionally install a span sink). Called once at
 *  process start; tests call it per case to flip tracing on and off. */
export function initTelemetry(options: InitTelemetryOptions = {}): void {
  enabled = options.enabled ?? flagEnabled(process.env.OTEL_ENABLED)
  sink = options.onSpanEnd ?? defaultSink
}

export function isTelemetryEnabled(): boolean {
  return enabled
}

export function getTracer(): Tracer {
  return enabled ? LIVE_TRACER : NOOP_TRACER
}

// Request -> span correlation for the API's Fastify hooks. A WeakMap means a
// span is collected with its request and never leaks between requests.
const requestSpans = new WeakMap<object, Span>()

export function setRequestSpan(request: object, span: Span): void {
  requestSpans.set(request, span)
}

export function requestSpan(request: object): Span | undefined {
  return requestSpans.get(request)
}

export function clearRequestSpan(request: object): void {
  requestSpans.delete(request)
}

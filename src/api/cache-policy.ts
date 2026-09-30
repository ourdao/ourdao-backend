import type { FastifyInstance, FastifyReply } from 'fastify'

/**
 * The only Cache-Control values this API may emit (issue #194). Routes pick a
 * policy by *name* via `setCachePolicy`; nothing writes a raw directive.
 * test/cache-policy.test.ts fails on an ad-hoc `Cache-Control` literal or on
 * any route whose response carries a value outside this set.
 *
 * - `public-live` — data at the chain tip, shared caches may hold it briefly.
 *   After 5s a cache must revalidate; with `@fastify/etag` that is a cheap
 *   conditional request answered with 304 when nothing changed.
 * - `public-historical` — a page reached through a `?before=`/`?after=`
 *   cursor. Rows behind the cursor are append-only, so shared caches may
 *   hold the page for an hour; after that they revalidate through ETag like
 *   everything else. Issue #190: it used to be `max-age=31536000, immutable`,
 *   which pinned any wrong response — a filtering bug, a shape change — in
 *   every intermediary and browser for a year with no way to invalidate,
 *   since no URL carries a version. One hour is the longest the team can
 *   wait out during an incident; `immutable` comes back only if a versioned
 *   path is ever introduced.
 * - `private` — member-specific data. Never `public`; `no-cache` forces every
 *   reuse to revalidate via ETag, so a shared cache can neither store nor
 *   serve it to someone else.
 * - `no-store` — never stored anywhere: authentication challenges and other
 *   authenticated mutations, health/readiness, diagnostics, the SSE stream.
 *   Also the DEFAULT for any route that names no policy.
 */
export const CACHE_POLICIES = {
  'public-live': 'public, max-age=5, must-revalidate',
  'public-historical': 'public, max-age=3600, must-revalidate',
  private: 'private, no-cache',
  'no-store': 'no-store',
} as const

export type CachePolicyName = keyof typeof CACHE_POLICIES

export const DEFAULT_CACHE_POLICY: CachePolicyName = 'no-store'

const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set(Object.values(CACHE_POLICIES))

export function isKnownCacheControl(value: unknown): boolean {
  return typeof value === 'string' && KNOWN_DIRECTIVES.has(value)
}

export function setCachePolicy(reply: FastifyReply, policy: CachePolicyName): void {
  reply.header('Cache-Control', CACHE_POLICIES[policy])
}

/** Longest lifetime any policy may grant a shared cache: one hour. A bad
 *  response must be recoverable within the span of an incident (issue #190). */
export const MAX_CACHE_LIFETIME_SECONDS = 3600

/** Picks `public-historical` for a cursor page and `public-live` for the tip. */
export function historicalOrLive(hasCursor: boolean): CachePolicyName {
  return hasCursor ? 'public-historical' : 'public-live'
}

/**
 * Installs the policy plumbing on the root instance (before any route is
 * registered, so child plugins inherit it):
 *
 * - `onRequest` applies the default, so a route that names nothing gets
 *   `no-store` rather than no header at all.
 * - `onSend` is the backstop: an unknown directive is replaced by `no-store`
 *   and logged; a request carrying credentials never receives a `public`
 *   response; and `no-store` responses drop their ETag (nothing may be stored,
 *   so there is nothing to revalidate).
 *
 * Runs after `@fastify/etag` registers, so it sees the final headers.
 */
export function registerCachePolicy(app: FastifyInstance): void {
  app.addHook('onRequest', async (_req, reply) => {
    setCachePolicy(reply, DEFAULT_CACHE_POLICY)
  })

  app.addHook('onSend', async (req, reply, payload) => {
    // Swagger UI serves its own static assets with their own headers.
    if (req.url.startsWith('/docs')) return payload

    let value = reply.getHeader('cache-control')
    if (!isKnownCacheControl(value)) {
      req.log.error({ cacheControl: value, url: req.url }, 'response set an ad-hoc Cache-Control; forcing no-store')
      setCachePolicy(reply, 'no-store')
      value = CACHE_POLICIES['no-store']
    }
    if (typeof value === 'string' && value.startsWith('public') && typeof req.headers.authorization === 'string') {
      // Authenticated requests are never shared-cacheable.
      setCachePolicy(reply, 'private')
      value = CACHE_POLICIES.private
    }
    if (value === CACHE_POLICIES['no-store']) reply.removeHeader('etag')
    return payload
  })
}

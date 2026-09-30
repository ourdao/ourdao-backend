import { createClient, type RedisClientType } from 'redis'
import { config } from '../config.js'

const HISTORY_CACHE_KEY = 'ourdao:api:stats:history:v1'
const HISTORY_CACHE_TTL_SECONDS = 3600

export interface LoanHistoryResponse {
  data: Array<{
    date: string
    principalLent: string
    principalRepaid: string
    defaults: number
    valueDefaulted: string
    cumulativeDefaultRatePercent: number
  }>
}

export function createHistoryCache(): {
  get(): Promise<LoanHistoryResponse | null>
  set(value: LoanHistoryResponse): Promise<void>
  close(): Promise<void>
} {
  let localValue: { expiresAt: number; value: LoanHistoryResponse } | null = null
  let client: RedisClientType | null = null
  let connecting: Promise<void> | null = null

  async function redisClient(): Promise<RedisClientType | null> {
    if (!config.cache.historyRedisUrl || process.env.VITEST || process.env.NODE_ENV === 'test') return null
    if (!client) {
      client = createClient({
        url: config.cache.historyRedisUrl,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
      })
      client.on('error', (error) => console.warn('[history-cache] Redis error:', error.message))
    }
    if (!client.isOpen) {
      connecting ??= client.connect().then(() => undefined).finally(() => { connecting = null })
      await connecting
    }
    return client
  }

  return {
    async get() {
      try {
        const redis = await redisClient()
        const cached = await redis?.get(HISTORY_CACHE_KEY)
        if (cached) return JSON.parse(cached) as LoanHistoryResponse
      } catch {
        // Continue with this process's cache or the database on Redis failure.
      }
      return localValue && localValue.expiresAt > Date.now() ? localValue.value : null
    },
    async set(value) {
      localValue = { expiresAt: Date.now() + HISTORY_CACHE_TTL_SECONDS * 1000, value }
      try {
        const redis = await redisClient()
        await redis?.set(HISTORY_CACHE_KEY, JSON.stringify(value), { EX: HISTORY_CACHE_TTL_SECONDS })
      } catch {
        // The local cache remains available if Redis is temporarily offline.
      }
    },
    async close() {
      if (client?.isOpen) await client.quit()
      client = null
    },
  }
}

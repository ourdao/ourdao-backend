import { describe, expect, it } from 'vitest'
import {
  assertContractConfigured,
  bool,
  int,
  resolveConfig,
  str,
} from '../src/config.js'

describe('config helpers', () => {
  it('str uses the fallback only for missing or empty values', () => {
    expect(str({}, 'MISSING', 'fallback')).toBe('fallback')
    expect(str({ VALUE: '' }, 'VALUE', 'fallback')).toBe('fallback')
    expect(str({ VALUE: 'configured' }, 'VALUE', 'fallback')).toBe('configured')
  })

  it('int uses the fallback for missing, empty, malformed, and non-integer values', () => {
    expect(int({}, 'MISSING', 7)).toBe(7)
    expect(int({ VALUE: '' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: 'not-a-number' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: '12ms' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: '1.5' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: '42' }, 'VALUE', 7)).toBe(42)
    expect(int({ VALUE: '-3' }, 'VALUE', 7)).toBe(-3)
  })

  it('bool uses the fallback for missing and empty values and recognizes true/1', () => {
    expect(bool({}, 'MISSING')).toBe(false)
    expect(bool({ VALUE: '' }, 'VALUE', true)).toBe(true)
    expect(bool({ VALUE: 'true' }, 'VALUE')).toBe(true)
    expect(bool({ VALUE: '1' }, 'VALUE')).toBe(true)
    expect(bool({ VALUE: 'false' }, 'VALUE', true)).toBe(false)
    expect(bool({ VALUE: 'unexpected' }, 'VALUE', true)).toBe(false)
  })
})

describe('resolveConfig', () => {
  it('matches every documented default', () => {
    const resolved = resolveConfig({})
    expect(resolved).toEqual({
      http: {
        port: 4000,
        host: '0.0.0.0',
        corsOrigin: 'http://localhost:3000',
        rateLimitMax: 100,
        rateLimitWindowMs: 60000,
        rateLimitEventsMax: 30,
        trustProxy: 'false',
        statsCacheMs: 5000,
      },
      db: { connectionString: undefined, nonceStore: 'postgres' },
      stellar: {
        contractId: '',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      },
      indexer: {
        startLedger: 0,
        startLookbackLedgers: 17280,
        pollIntervalMs: 5000,
        pageLimit: 100,
        maxBackoffMs: 60000,
        maxDrainPages: 20,
        maxDrainMs: 30000,
        staleAfterMs: 120000,
        quarantineAfterFailures: 3,
        resetOnContractChange: false,
      },
    })
  })

  it('resolves supplied values and falls back from malformed integers', () => {
    const resolved = resolveConfig({
      PORT: '4100',
      HOST: '127.0.0.1',
      CORS_ORIGIN: ' https://app.example ',
      DATABASE_URL: 'postgres://example',
      CONTRACT_ID: 'C123',
      POLL_INTERVAL_MS: 'bad',
      INDEXER_RESET_ON_CONTRACT_CHANGE: '1',
    })
    expect(resolved.http.port).toBe(4100)
    expect(resolved.http.host).toBe('127.0.0.1')
    expect(resolved.http.corsOrigin).toBe('https://app.example')
    expect(resolved.db.connectionString).toBe('postgres://example')
    expect(resolved.stellar.contractId).toBe('C123')
    expect(resolved.indexer.pollIntervalMs).toBe(5000)
    expect(resolved.indexer.resetOnContractChange).toBe(true)
  })
})

describe('assertContractConfigured', () => {
  it('throws the documented error when CONTRACT_ID is missing', () => {
    expect(() => assertContractConfigured(resolveConfig({}))).toThrow(
      'CONTRACT_ID is not set. The indexer needs the deployed OurDAO contract id to poll events.'
    )
  })

  it('returns the configured contract id', () => {
    expect(assertContractConfigured(resolveConfig({ CONTRACT_ID: 'C123' }))).toBe('C123')
  })
})

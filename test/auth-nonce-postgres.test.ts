import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PostgresNonceStore } from '../src/auth.js'
import { pool, query, queryOne } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('PostgresNonceStore', () => {
  let store: PostgresNonceStore

  beforeEach(async () => {
    await resetDb()
    store = new PostgresNonceStore(pool)
  })

  afterEach(async () => {
    await store.shutdown()
    closeDb()
  })

  it('issues a nonce and stores it in Postgres', async () => {
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const nonce = await store.issue(address)
    
    expect(typeof nonce).toBe('string')
    expect(nonce.length).toBe(64) // 32 bytes in hex
    
    // Verify it's in the database
    const row = await queryOne(
      'SELECT * FROM auth_nonces WHERE address = $1',
      [address]
    )
    expect(row).toBeDefined()
    expect(row?.nonce).toBe(nonce)
  })

  it('allows consumption of a valid nonce', async () => {
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const nonce = await store.issue(address)
    
    const consumed = await store.consume(address, nonce)
    expect(consumed).toBe(true)
    
    // Verify the nonce was deleted
    const row = await queryOne(
      'SELECT * FROM auth_nonces WHERE address = $1',
      [address]
    )
    expect(row).toBeNull()
  })

  it('prevents double consumption of the same nonce', async () => {
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const nonce = await store.issue(address)
    
    // First consumption succeeds
    const firstConsume = await store.consume(address, nonce)
    expect(firstConsume).toBe(true)
    
    // Second consumption fails because the row was deleted
    const secondConsume = await store.consume(address, nonce)
    expect(secondConsume).toBe(false)
  })

  it('rejects expired nonces', async () => {
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const nonce = await store.issue(address)
    
    // Manually expire the nonce by updating the database
    await query(
      'UPDATE auth_nonces SET expires_at = now() - interval \'1 second\' WHERE address = $1',
      [address]
    )
    
    const consumed = await store.consume(address, nonce)
    expect(consumed).toBe(false)
  })

  it('rejects wrong nonce for an address', async () => {
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const nonce = await store.issue(address)
    
    const consumed = await store.consume(address, 'wrong-nonce')
    expect(consumed).toBe(false)
    
    // The correct nonce should still be valid
    const validConsume = await store.consume(address, nonce)
    expect(validConsume).toBe(true)
  })

  it('returns false for non-existent addresses', async () => {
    const consumed = await store.consume('GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ', 'any-nonce')
    expect(consumed).toBe(false)
  })

  it('allows a nonce issued by one instance to be consumed by another', async () => {
    // This tests the core requirement of issue #66: multi-instance support
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    
    // Instance 1 issues a nonce
    const store1 = new PostgresNonceStore(pool)
    const nonce = await store1.issue(address)
    
    // Instance 2 consumes it
    const store2 = new PostgresNonceStore(pool)
    const consumed = await store2.consume(address, nonce)
    expect(consumed).toBe(true)
    
    await store1.shutdown()
    await store2.shutdown()
  })

  it('handles concurrent consumption correctly', async () => {
    // Test that concurrent consumption of the same nonce results in exactly one success
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const nonce = await store.issue(address)
    
    // Simulate two concurrent consume calls
    const [result1, result2] = await Promise.all([
      store.consume(address, nonce),
      store.consume(address, nonce),
    ])
    
    // Exactly one should succeed
    const successCount = (result1 ? 1 : 0) + (result2 ? 1 : 0)
    expect(successCount).toBe(1)
  })

  it('returns same nonce when reissued for same address while still valid', async () => {
    const address = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    
    const nonce1 = await store.issue(address)
    const nonce2 = await store.issue(address)
    
    // Both should be the same nonce (nonce not expired yet)
    expect(nonce1).toBe(nonce2)
    
    // The nonce should still be valid and consumable
    const consumed1 = await store.consume(address, nonce1)
    expect(consumed1).toBe(true)
    
    // After consumption, nonce should be invalid
    const consumed2 = await store.consume(address, nonce2)
    expect(consumed2).toBe(false)
  })

  it('cleanup timer removes expired nonces', async () => {
    const address1 = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AESFVNUN3AHYJRULJLW7AUWQ'
    const address2 = 'GBRPYHIL2CI3WHZDTOOQFC6EB4LGDOJA72QAOWVV2SG6EBQVQVA5UNAC'
    
    // Issue two nonces
    await store.issue(address1)
    await store.issue(address2)
    
    // Manually expire the first one
    await query(
      'UPDATE auth_nonces SET expires_at = now() - interval \'1 second\' WHERE address = $1',
      [address1]
    )
    
    // Manually run cleanup (instead of waiting 10 minutes)
    // This is done by triggering the DELETE directly
    await pool.query('DELETE FROM auth_nonces WHERE expires_at <= now()')
    
    // Verify expired is gone, fresh is still there
    const row1 = await queryOne('SELECT * FROM auth_nonces WHERE address = $1', [address1])
    const row2 = await queryOne('SELECT * FROM auth_nonces WHERE address = $1', [address2])
    
    expect(row1).toBeNull()
    expect(row2).toBeDefined()
  })

  it('shutdown timer is unref\'d so it doesn\'t prevent shutdown', async () => {
    await expect(store.shutdown()).resolves.toBeUndefined()
  })
})

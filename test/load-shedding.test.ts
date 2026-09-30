import { describe, expect, it } from 'vitest'
import { ConcurrencyGate, ConcurrencyLimitError } from '../src/api/load-shedding.js'

describe('ConcurrencyGate', () => {
  it('acquires and releases capacity up to the configured limit', () => {
    const gate = new ConcurrencyGate(2)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
    expect(gate.activeCount).toBe(2)

    gate.release()
    expect(gate.activeCount).toBe(1)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.activeCount).toBe(2)

    gate.release()
    gate.release()
    expect(gate.activeCount).toBe(0)
    // Extra releases should not drive active count below 0
    gate.release()
    expect(gate.activeCount).toBe(0)
  })

  it('run executes action and releases capacity on success', async () => {
    const gate = new ConcurrencyGate(1)
    const result = await gate.run(async () => {
      expect(gate.activeCount).toBe(1)
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(gate.activeCount).toBe(0)
  })

  it('run guarantees release when action throws a synchronous error (#272)', async () => {
    const gate = new ConcurrencyGate(1)
    await expect(
      gate.run(() => {
        throw new Error('sync failure')
      })
    ).rejects.toThrow('sync failure')

    expect(gate.activeCount).toBe(0)
    expect(gate.tryAcquire()).toBe(true)
    gate.release()
  })

  it('run guarantees release when action rejects asynchronously', async () => {
    const gate = new ConcurrencyGate(1)
    await expect(
      gate.run(async () => {
        await Promise.resolve()
        throw new Error('async failure')
      })
    ).rejects.toThrow('async failure')

    expect(gate.activeCount).toBe(0)
    expect(gate.tryAcquire()).toBe(true)
    gate.release()
  })

  it('run throws ConcurrencyLimitError when capacity is exhausted', async () => {
    const gate = new ConcurrencyGate(1)
    expect(gate.tryAcquire()).toBe(true)

    await expect(
      gate.run(async () => 'never')
    ).rejects.toThrow(ConcurrencyLimitError)

    gate.release()
    expect(gate.activeCount).toBe(0)
  })
})

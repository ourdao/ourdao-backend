// Issue #272: ConcurrencyGate leaked capacity when a guarded call threw before
// reaching its release, which eventually shed every request. `run()` is the
// guarantee that this cannot happen, so these tests attack it from every exit
// path a handler can take.
import { describe, expect, it } from 'vitest'
import { ConcurrencyGate, GateShedError } from '../src/api/load-shedding.js'

describe('ConcurrencyGate (#272)', () => {
  it('releases the slot after a synchronous throw', async () => {
    const gate = new ConcurrencyGate(1)

    await expect(
      gate.run(() => {
        throw new Error('boom before any await')
      })
    ).rejects.toThrow('boom before any await')

    expect(gate.activeCount).toBe(0)

    // The slot must be usable again: this is the leak the issue reports.
    const value = await gate.run(async () => 'recovered')
    expect(value).toBe('recovered')
    expect(gate.activeCount).toBe(0)
  })

  it('releases the slot after an asynchronous rejection', async () => {
    const gate = new ConcurrencyGate(1)

    await expect(
      gate.run(async () => {
        throw new Error('async boom')
      })
    ).rejects.toThrow('async boom')

    expect(gate.activeCount).toBe(0)
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('releases the slot when the work resolves', async () => {
    const gate = new ConcurrencyGate(2)

    const result = await gate.run(async () => 42)

    expect(result).toBe(42)
    expect(gate.activeCount).toBe(0)
  })

  it('holds the slot for the duration of the work', async () => {
    const gate = new ConcurrencyGate(1)
    let seenDuringWork = -1

    await gate.run(async () => {
      seenDuringWork = gate.activeCount
    })

    expect(seenDuringWork).toBe(1)
    expect(gate.activeCount).toBe(0)
  })

  it('sheds with GateShedError instead of running when full', async () => {
    const gate = new ConcurrencyGate(1)
    let ran = false

    let release!: () => void
    const held = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    await expect(
      gate.run(async () => {
        ran = true
        return 'should not run'
      })
    ).rejects.toBeInstanceOf(GateShedError)

    expect(ran).toBe(false)
    expect(gate.activeCount).toBe(1)

    release()
    await held
    expect(gate.activeCount).toBe(0)
  })

  it('does not leak under a high error rate', async () => {
    // The acceptance criterion: capacity stays accurate even when calls fail.
    // Callers retry when shed (that is the documented contract), so drive the
    // gate the way a real caller does and assert that all 200 attempts
    // eventually run and that the gate is idle afterwards. A leak would show
    // up as a shed that never clears, or `activeCount` stuck above zero.
    const gate = new ConcurrencyGate(4)
    const attempts = 200
    let ran = 0
    let shedCount = 0

    const runWithRetry = async (i: number): Promise<void> => {
      for (;;) {
        try {
          await gate.run(async () => {
            ran += 1
            if (i % 2 === 0) throw new Error(`failure ${i}`)
            return i
          })
          return
        } catch (err) {
          if (err instanceof GateShedError) {
            shedCount += 1
            await new Promise((resolve) => setTimeout(resolve, 1))
            continue
          }
          if (i % 2 === 0) return // the work's own error, as expected
          throw err
        }
      }
    }

    await Promise.all(Array.from({ length: attempts }, (_, i) => runWithRetry(i)))

    expect(ran).toBe(attempts)
    expect(gate.activeCount).toBe(0)

    // Every slot is available afterwards.
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => gate.run(async () => 'ok'))
    )
    expect(concurrent).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(gate.activeCount).toBe(0)
    // Shedding happened (the gate was genuinely under pressure) but every
    // shed was recoverable, which is the property that was broken before.
    expect(shedCount).toBeGreaterThan(0)
  })

  it('admits up to the limit and sheds the rest when all work is in flight', async () => {
    // A synchronous burst cannot be admitted in waves: all 30 calls reach
    // tryAcquire() before any of them awaits, so exactly `limit` get in.
    const gate = new ConcurrencyGate(3)
    let peak = 0
    let admitted = 0

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        gate.run(async () => {
          admitted += 1
          peak = Math.max(peak, gate.activeCount)
          await new Promise((resolve) => setTimeout(resolve, 1))
        })
      )
    )

    const shed = results.filter((r) => r.status === 'rejected' && r.reason instanceof GateShedError)
    expect(admitted).toBe(3)
    expect(shed).toHaveLength(27)
    expect(peak).toBeLessThanOrEqual(3)
    expect(gate.activeCount).toBe(0)
  })
})

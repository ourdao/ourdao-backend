/**
 * A non-queueing concurrency gate for work that is deliberately lower
 * priority than ordinary API reads. Callers either enter immediately or shed
 * the request; they never wait behind work that could otherwise consume the
 * request pool indefinitely.
 */

/** Thrown by `ConcurrencyGate.run` when no slot is available. */
export class GateShedError extends Error {
  constructor() {
    super('concurrency gate is at capacity')
    this.name = 'GateShedError'
  }
}

export class ConcurrencyGate {
  private active = 0

  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false
    this.active += 1
    return true
  }

  release(): void {
    this.active -= 1
  }

  /** Slots currently held. Used by tests and by diagnostics endpoints. */
  get activeCount(): number {
    return this.active
  }

  /**
   * Run `fn` while holding a slot, releasing it on every exit path.
   *
   * `tryAcquire()` followed by a `try`/`finally` looks equivalent but is not:
   * acquisition and the `try` are separate statements, so anything that throws
   * between them — including a synchronous throw while evaluating the guarded
   * work — leaks the slot for the lifetime of the process. Once `limit` such
   * leaks accumulate the gate sheds every request, which is the failure mode
   * this helper exists to make impossible (#272).
   *
   * Throws `GateShedError` without invoking `fn` when the gate is full, so a
   * caller can tell "shed" apart from "ran and threw".
   */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!this.tryAcquire()) throw new GateShedError()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

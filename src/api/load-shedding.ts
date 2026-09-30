/**
 * A non-queueing concurrency gate for work that is deliberately lower
 * priority than ordinary API reads. Callers either enter immediately or shed
 * the request; they never wait behind work that could otherwise consume the
 * request pool indefinitely.
 */
export class ConcurrencyGate {
  private active = 0

  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false
    this.active += 1
    return true
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1
    }
  }

  get activeCount(): number {
    return this.active
  }

  get capacity(): number {
    return this.limit
  }

  /**
   * Executes an asynchronous task inside the gate, guaranteeing that capacity
   * is released in a finally block regardless of whether `fn` resolves,
   * rejects asynchronously, or throws synchronously.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire()) {
      throw new ConcurrencyLimitError('Concurrency limit reached')
    }
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

export class ConcurrencyLimitError extends Error {
  constructor(message = 'Concurrency limit reached') {
    super(message)
    this.name = 'ConcurrencyLimitError'
  }
}

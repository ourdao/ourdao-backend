// Issue #191: acknowledge a recorded ledger discontinuity without rebuilding.
//
// `npm run reorg:clear` — for a false alarm (an RPC that briefly served a
// wrong hash, a rewind the network itself corrected) confirmed per the triage
// steps in docs/REORG_RECOVERY.md. After a *real* divergence use
// `npm run reindex` instead: it rebuilds the derived tables and clears the
// halt in the same transaction. Either way the worker refuses to start until
// one of the two has run.
import { pool } from '../db/index.js'
import { clearReorgHalts, loadUnclearedReorgHalt, type ReorgHalt } from './poller.js'

export interface ClearReorgResult {
  /** The halt that was open before clearing, or null when there was none. */
  halt: ReorgHalt | null
  /** How many records were marked cleared. */
  cleared: number
}

/** Clear every uncleared halt on behalf of the operator. Logs what it did;
 *  a no-op (nothing recorded) is reported rather than treated as an error. */
export async function clearRecordedReorg(
  log: { log(msg: string): void } = console
): Promise<ClearReorgResult> {
  const halt = await loadUnclearedReorgHalt()
  if (!halt) {
    log.log('[reorg:clear] no uncleared ledger discontinuity recorded — nothing to do')
    return { halt: null, cleared: 0 }
  }
  log.log(
    `[reorg:clear] clearing the discontinuity recorded at ${new Date(halt.detected_at).toISOString()} ` +
      `on ${halt.contract_id} (last folded ledger ${halt.last_ledger ?? 'unknown'}): ${halt.detail}`
  )
  const cleared = await clearReorgHalts('operator')
  log.log(`[reorg:clear] cleared ${cleared} record(s); the worker may be restarted`)
  return { halt, cleared }
}

// `npm run reorg:clear`
/* v8 ignore start -- run-directly entrypoint, exercised as a subprocess not by vitest (#79) */
if (import.meta.url === `file://${process.argv[1]}`) {
  clearRecordedReorg()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[reorg:clear] failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
/* v8 ignore stop */

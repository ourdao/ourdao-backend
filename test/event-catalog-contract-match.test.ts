/**
 * Test asserting EVENT_FIELDS matches the contract event catalog (issue #202).
 * 
 * Every time the contract adds an event, the catalog goes stale silently — the
 * handler no-ops, and derived state is quietly incomplete until someone notices.
 * This test makes that drift a test failure instead.
 * 
 * The fixture at test/fixtures/contract-event-catalog.json describes what the
 * contract publishes. It must stay current — see that file's header comment
 * for the generation/update process.
 */

import { describe, test, expect } from 'vitest'
import { EVENT_FIELDS, type EventSymbol } from '../src/stellar/events.js'
import contractCatalog from './fixtures/contract-event-catalog.json' with { type: 'json' }

describe('EVENT_FIELDS contract catalog match', () => {
  test('every contract event has a catalog entry', () => {
    const missingInCatalog: string[] = []
    
    for (const symbol of Object.keys(contractCatalog.events)) {
      if (!(symbol in EVENT_FIELDS)) {
        missingInCatalog.push(symbol)
      }
    }
    
    if (missingInCatalog.length > 0) {
      throw new Error(
        `Contract events missing from EVENT_FIELDS catalog: ${missingInCatalog.join(', ')}.\n` +
        `Add them to src/stellar/events.ts and implement handlers in src/indexer/handlers.ts.`
      )
    }
  })

  test('every catalog entry corresponds to a contract event', () => {
    const extraInCatalog: string[] = []
    
    for (const symbol of Object.keys(EVENT_FIELDS)) {
      if (!(symbol in contractCatalog.events)) {
        extraInCatalog.push(symbol)
      }
    }
    
    if (extraInCatalog.length > 0) {
      throw new Error(
        `EVENT_FIELDS contains symbols not in contract catalog: ${extraInCatalog.join(', ')}.\n` +
        `Either the contract removed them, or the fixture is stale — update test/fixtures/contract-event-catalog.json.`
      )
    }
  })

  test('field names and order match exactly', () => {
    const mismatches: string[] = []
    
    for (const [symbol, contractFields] of Object.entries(contractCatalog.events)) {
      if (!(symbol in EVENT_FIELDS)) continue // covered by the first test
      
      const catalogFields = EVENT_FIELDS[symbol as EventSymbol] as readonly string[]
      
      // Check length
      if (catalogFields.length !== contractFields.length) {
        mismatches.push(
          `${symbol}: catalog has ${catalogFields.length} fields, contract has ${contractFields.length}`
        )
        continue
      }
      
      // Check field names and order (positional tuples)
      for (let i = 0; i < catalogFields.length; i++) {
        if (catalogFields[i] !== contractFields[i]) {
          mismatches.push(
            `${symbol}[${i}]: catalog="${catalogFields[i]}", contract="${contractFields[i]}"`
          )
        }
      }
    }
    
    if (mismatches.length > 0) {
      throw new Error(
        `Field order/name mismatches between EVENT_FIELDS and contract:\n${mismatches.map(m => `  - ${m}`).join('\n')}\n` +
        `Fix src/stellar/events.ts to match the contract's published tuple order exactly.`
      )
    }
  })

  test('fixture metadata is present', () => {
    expect(contractCatalog.version).toBeDefined()
    expect(contractCatalog.contractVersion).toBeDefined()
    expect(contractCatalog.generatedAt).toBeDefined()
  })

  test('reports current drift against known gaps', () => {
    // Issue #123 documents 4 missing events as of 2026-09-24
    // If the catalog now includes them, this test should be updated
    const knownMissing = ['tre_wait', 'tre_rej', 'loan_wait', 'loan_rej']
    const actualMissing = knownMissing.filter(symbol => !(symbol in EVENT_FIELDS))
    
    // If actualMissing is empty, that's good — all previously missing events are now added
    // If it still contains entries, they're still missing (no error, just documentation)
    if (actualMissing.length > 0) {
      console.warn(
        `Note: ${actualMissing.length} contract events remain missing from EVENT_FIELDS (issue #123): ${actualMissing.join(', ')}`
      )
    }
  })
})

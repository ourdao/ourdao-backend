// Migration reversibility policy (issue #197): migrations are forward-only,
// and every one must be backward-compatible with the PREVIOUS application
// release so an image rollback never meets a schema it cannot run against.
// A migration that cannot meet that rule must say so on its first line:
//
//   -- compat: backward-compatible
//   -- compat: breaking (<why the previous release cannot run against it>)
//
// Enforced by test/migration-policy.test.ts; the policy itself is written up
// in CONTRIBUTING.md ("Schema changes") and docs/DEPLOYMENT.md ("Rolling back
// a bad deploy").

export type MigrationCompat = { kind: 'backward-compatible' } | { kind: 'breaking'; reason: string }

export function parseCompat(sql: string): MigrationCompat | null {
  const first = sql.split('\n', 1)[0]?.trim() ?? ''
  if (first === '-- compat: backward-compatible') return { kind: 'backward-compatible' }
  const m = /^-- compat: breaking \((.+)\)$/.exec(first)
  return m ? { kind: 'breaking', reason: m[1]! } : null
}

// Statement shapes that change or remove something the previous release may
// still depend on, or reject data it still writes. Additive changes
// (ADD COLUMN with a default or nullable, CREATE TABLE, CREATE INDEX) are not
// listed. A migration matching one of these must be annotated `breaking`.
const BREAKING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bDROP\s+(COLUMN|TABLE)\b/i, 'drops a column or table'],
  [/\bRENAME\b/i, 'renames a column, table or constraint'],
  [/\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [/\bSET\s+NOT\s+NULL\b/i, 'adds NOT NULL to an existing column'],
  [/\bADD\s+CONSTRAINT\b/i, 'adds a constraint to an existing table'],
  [/\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i, 'adds a NOT NULL column without a default'],
]

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/** Returns the reasons `sql` needs a `breaking` annotation (empty if none). */
export function breakingReasons(sql: string): string[] {
  const body = stripComments(sql)
  return BREAKING_PATTERNS.filter(([re]) => re.test(body)).map(([, why]) => why)
}

/** Returns policy violations for one migration file (empty if it conforms). */
export function checkMigration(name: string, sql: string): string[] {
  const compat = parseCompat(sql)
  if (!compat) return [`${name}: first line must be "-- compat: backward-compatible" or "-- compat: breaking (<reason>)"`]
  const reasons = breakingReasons(sql)
  if (compat.kind === 'backward-compatible' && reasons.length > 0) {
    return [`${name}: annotated backward-compatible but ${reasons.join('; ')} — annotate it "breaking (...)" or split it (expand/contract)`]
  }
  return []
}

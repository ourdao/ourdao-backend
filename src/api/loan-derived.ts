import type { LoanRow } from '../types.js'

export type LoanWithDerived = LoanRow & {
  interest_charge: string | null
  repaid_amount: string | null
}

interface WarnLogger {
  warn: (obj: object, msg: string) => void
}

// The amount columns are NUMERIC(40,0), so `pg` hands back plain decimal
// integer strings. Anything else — a scaled "100.00" after a careless type
// change, null, garbage — must not reach BigInt(), which throws SyntaxError
// (issue #195). Returns null rather than throwing so the caller can degrade a
// single row instead of failing the whole request.
export function parseIntegerAmount(value: unknown): bigint | null {
  // The member summary embeds loans through row_to_json, where NUMERIC
  // arrives as a JSON number rather than a string.
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) return null
  return BigInt(value)
}

// A loan's interest charge and repayment progress aren't stored columns —
// both derive from total_repayment, which issue #11 added — so compute them
// at read time rather than duplicating state that could drift out of sync.
// BigInt (not Number) because these are NUMERIC(40,0) decimal strings that
// can exceed Number.MAX_SAFE_INTEGER.
//
// Issue #195: a malformed amount fails that row's derived fields only — they
// come back as null and the problem is logged with the loan id — rather than
// turning /api/loans, /api/loans/:id and the member summary into a 500.
export function withLoanDerived(loan: LoanRow, log?: WarnLogger): LoanWithDerived {
  const totalRepayment = parseIntegerAmount(loan.total_repayment)
  const amount = parseIntegerAmount(loan.amount)
  const outstanding = parseIntegerAmount(loan.outstanding)
  if (totalRepayment === null || amount === null || outstanding === null) {
    log?.warn(
      { loanId: loan.id, amount: loan.amount, outstanding: loan.outstanding, total_repayment: loan.total_repayment },
      'loan has a malformed amount column; derived fields omitted'
    )
    return { ...loan, interest_charge: null, repaid_amount: null }
  }
  return {
    ...loan,
    interest_charge: (totalRepayment - amount).toString(),
    repaid_amount: (totalRepayment - outstanding).toString(),
  }
}

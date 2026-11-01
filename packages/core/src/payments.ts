import type { Bill, Month, PlannerState } from './types.js';
import { r2 } from './money.js';
import { applyHeloc, isHelocBill, unapplyHeloc } from './heloc.js';
import { applyLoan, loanFor, unapplyLoan } from './loans.js';

/** Put back an amount an older planner version took out of an account balance (rule 13). */
export function unapplyBalance(m: Month, b: Bill): void {
  const a = b.balanceApplied;
  if (!a) return;
  const acct = m.accounts.find(x => x.id === a.acctId);
  if (acct && a.amount) acct.balance = r2((Number(acct.balance) || 0) + Number(a.amount));
  b.balanceApplied = null;
}

/**
 * Rules 2 and 3. Paid is only a marker, except for loan bills: a bill linked to a loan, or named HELOC,
 * applies its payment to that loan when checked. Any earlier application is reversed first, so calling this
 * after unchecking, editing the amount or moving the bill always leaves exactly one application (or none).
 */
export function syncPayment(m: Month, b: Bill, key: string): void {
  unapplyBalance(m, b);
  unapplyHeloc(m, b);
  unapplyLoan(m, b);
  if (!b.paid) return;
  if (isHelocBill(b)) { applyHeloc(m, b, key); return; }
  const l = loanFor(m, b);
  if (l) applyLoan(b, l);
}

/** Reverse whatever a bill applied, before it is deleted. */
export function unapplyAll(m: Month, b: Bill): void {
  unapplyBalance(m, b);
  unapplyHeloc(m, b);
  unapplyLoan(m, b);
}

/** Rule 13: old backups' `balanceApplied` amounts are added back to the balances on import. */
export function restoreOldDeductions(st: PlannerState): PlannerState {
  Object.values(st.months || {}).forEach(m => (m.bills || []).forEach(b => unapplyBalance(m, b)));
  return st;
}

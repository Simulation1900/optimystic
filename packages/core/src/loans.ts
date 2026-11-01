import type { Bill, Loan, Month } from './types.js';
import { r2 } from './money.js';
import { addMonths, mIdx } from './dates.js';

export const loanFor = (m: Month, b: Pick<Bill, 'name'>): Loan | undefined =>
  m.loans.find(l => l.billName && l.billName.trim().toLowerCase() === String(b.name || '').trim().toLowerCase());

export type LoanOptKey = 'cur' | 'b0' | 'b1' | 'custom';
export interface LoanPlan {
  key: LoanOptKey; name: string; P: number; never?: boolean;
  n?: number; interest?: number; payoff?: string | null; at?: (k: number) => number;
}

/** Rule 8: payoff dates and interest from a month-by-month run of the balance. */
export function loanCalc(m: Month, l: Loan, key: string) {
  const B = Math.max(0, Number(l.balance) || 0), r = (Number(l.rate) || 0) / 1200;
  const escw = Math.max(0, Number(l.escrow) || 0), pi = r2((Number(l.payment) || 0) - escw);
  const plan = (P: number): Omit<LoanPlan, 'key' | 'name'> => {
    if (B <= 0) return { P, n: 0, interest: 0, payoff: null, at: () => 0 };
    if (P <= B * r + 1e-9) return { P, never: true };
    let bal = B, paid = 0, n = 0;
    while (bal > 0.004 && n < 1200) { const due = bal * (1 + r), p = Math.min(P, due); paid += p; bal = due - p; n++; }
    return {
      P, n, interest: r2(paid - B), payoff: addMonths(key, n - 1),
      at: k => k >= n ? 0 : Math.max(0, r ? B * Math.pow(1 + r, k) - P * (Math.pow(1 + r, k) - 1) / r : B - P * k)
    };
  };
  const bumps = l.kind === 'home' ? [100, 250] : [50, 100];
  const opts: LoanPlan[] = [{ key: 'cur', name: 'Current payment', ...plan(pi) } as LoanPlan]
    .concat(bumps.map((x, i) => ({ key: ('b' + i) as LoanOptKey, name: `Pay $${x} more`, ...plan(r2(pi + x)) })));
  const cp = r2(Number(l.customPmt) || 0);
  const custom: LoanPlan | null = cp > 0 ? { key: 'custom', name: 'Your payment', ...plan(r2(cp - escw)) } : null;

  const V = Number(l.value) || 0, g = (Number(l.valueRate) || 0) / 100;
  const off = mIdx(key) - mIdx(l.valueAsOf || key);
  const valAt = V > 0 && l.kind !== 'other' ? (k: number) => V * Math.pow(1 + g, (off + k) / 12) : null;

  let sched: { made: number; left: number; first: string; last: string; pmt?: number } | null = null;
  const term = Math.round(Number(l.term) || 0);
  if (l.open && term > 0) {
    const first = l.kind === 'home' ? 2 : 1; // mortgages: first payment ~2 months after closing; car loans ~1
    const made = Math.min(term, Math.max(0, mIdx(key) - mIdx(l.open) - first));
    sched = { made, left: term - made, first: addMonths(l.open, first), last: addMonths(l.open, first + term - 1) };
    const O = Number(l.original) || 0;
    if (O > 0) sched.pmt = r2(r ? O * r / (1 - Math.pow(1 + r, -term)) : O / term);
  }
  const bill = m.bills.find(b => loanFor(m, b) === l) || null;
  const equity = valAt ? r2(valAt(0) - B) : null;
  let flipsPositive: string | null = null;
  const cur = opts[0];
  if (equity !== null && equity < 0 && !cur.never && cur.at && valAt) {
    let k = 0;
    while (k <= (cur.n || 0) && valAt(k) < cur.at(k)) k++;
    if (k <= (cur.n || 0)) flipsPositive = addMonths(key, k);
  }
  return { B, r, escw, pi, opts, custom, valAt, sched, bill, applied: bill?.loanApplied || null, equity, flipsPositive };
}
export type LoanCalc = ReturnType<typeof loanCalc>;

/** Rule 4: escrow first, then interest = balance × APR ÷ 12, the rest to principal, never more than the balance. */
export function applyLoan(b: Bill, l: Loan): void {
  const B = Math.max(0, Number(l.balance) || 0), r = (Number(l.rate) || 0) / 1200, amt = Number(b.amount) || 0;
  const escrowPart = r2(Math.min(amt, Math.max(0, Number(l.escrow) || 0)));
  const toLoan = r2(amt - escrowPart);
  const interest = r2(Math.min(toLoan, B * r));
  const principal = r2(Math.min(B, Math.max(0, toLoan - interest)));
  l.balance = r2(B - principal);
  b.loanApplied = { loanId: l.id, interest, principal, escrow: escrowPart };
}

export function unapplyLoan(m: Month, b: Bill): void {
  const a = b.loanApplied;
  if (!a) return;
  const l = m.loans.find(x => x.id === a.loanId);
  if (l) l.balance = r2((Number(l.balance) || 0) + a.principal);
  b.loanApplied = null;
}

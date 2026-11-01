import type { Bill, Month } from './types.js';
import { ceil2, r2 } from './money.js';
import { addMonths, daysIn, mIdx } from './dates.js';
import { shortfalls } from './accounts.js';
import { uid } from './ids.js';

export const isHelocBill = (b: Pick<Bill, 'name'>): boolean => /heloc/i.test(b.name || '');
export const helocBill = (m: Month): Bill | undefined => m.bills.find(isHelocBill);

export type HelocOptKey = 'min' | 'draw' | 'y5' | 'y3' | 'custom';
export interface HelocOption {
  key: HelocOptKey; name: string; n: number; pmt: number; pmt2?: number | null;
  interest: number; payoff: string; at: (k: number) => number;
}
export interface HelocCustom {
  key: 'custom'; name: string; pmt: number; never?: boolean;
  n?: number; interest?: number; payoff?: string; at?: (k: number) => number;
}

/** Amortized payment, unrounded. */
export const amRaw = (bal: number, n: number, r: number): number =>
  bal <= 0 ? 0 : n <= 0 ? bal : (r ? bal * r / (1 - Math.pow(1 + r, -n)) : bal / n);

/** Everything the HELOC panel shows for one month (rules 5 and 6). */
export function helocCalc(m: Month, key: string) {
  const h = m.heloc;
  const B = Math.max(0, Number(h.balance) || 0);
  const rate = (Number(h.rate) || 0) / 100, r = rate / 12;
  const endKey = addMonths(h.start || '2025-05', Math.round((Number(h.drawYears) || 0) * 12));
  const mLeft = Math.max(0, mIdx(endKey) - mIdx(key));
  const io = r2(B * r);
  const amort = (n: number, k: HelocOptKey, name: string): HelocOption | null => {
    if (n <= 0) return null;
    const raw = B <= 0 ? 0 : (r ? B * r / (1 - Math.pow(1 + r, -n)) : B / n);
    return {
      key: k, name, n, pmt: ceil2(raw), interest: r2(raw * n - B), payoff: addMonths(key, n - 1),
      at: x => x >= n ? 0 : (r ? B * Math.pow(1 + r, x) - raw * (Math.pow(1 + r, x) - 1) / r : B - raw * x)
    };
  };
  const repayM = Math.round((Number(h.repayYears) || 0) * 12);
  const repayEndKey = addMonths(endKey, repayM);
  const repayLeft = Math.max(0, mIdx(repayEndKey) - mIdx(key));
  const balAt = (bal: number, p: number, k: number) => Math.max(0, r ? bal * Math.pow(1 + r, k) - p * (Math.pow(1 + r, k) - 1) / r : bal - p * k);
  let min: HelocOption;
  if (mLeft > 0) { // interest-only now, then amortize over the repayment period
    const rp = amRaw(B, repayM, r);
    min = {
      key: 'min', name: 'Minimum', n: mLeft + repayM, pmt: io, pmt2: ceil2(rp),
      interest: r2(io * mLeft + rp * repayM - B), payoff: addMonths(key, mLeft + repayM - 1),
      at: k => k <= mLeft ? B : balAt(B, rp, k - mLeft)
    };
  } else { // already in the repayment period
    const n = Math.max(1, repayLeft), rp = amRaw(B, n, r);
    min = {
      key: 'min', name: 'Minimum', n, pmt: ceil2(rp), pmt2: null, interest: r2(rp * n - B),
      payoff: addMonths(key, n - 1), at: k => k >= n ? 0 : balAt(B, rp, k)
    };
  }
  const opts: Array<HelocOption | null> = [min];
  if (mLeft > 0) opts.push(amort(mLeft, 'draw', 'By draw end'));
  opts.push(amort(60, 'y5', 'In 5 years'), amort(36, 'y3', 'In 3 years'));

  const P = r2(Number(h.customPmt) || 0);
  const custom: HelocCustom = { key: 'custom', name: 'Your payment', pmt: P };
  if (P > 0 && B > 0) {
    if (r && P <= B * r + 1e-9) custom.never = true;
    else {
      const n = Math.ceil((r ? -Math.log(1 - B * r / P) / Math.log(1 + r) : B / P) - 1e-9);
      let bal = B, paid = 0;
      for (let k = 0; k < n; k++) { const due = bal * (1 + r); const pay = Math.min(P, due); paid += pay; bal = due - pay; }
      Object.assign(custom, {
        n, interest: r2(paid - B), payoff: addMonths(key, n - 1),
        at: (k: number) => k >= n ? 0 : Math.max(0, r ? B * Math.pow(1 + r, k) - P * (Math.pow(1 + r, k) - 1) / r : B - P * k)
      });
    }
  }
  const hbill = helocBill(m), applied = hbill?.helocApplied || null;
  const preB = r2(B + (applied ? applied.principal : 0)); // balance before this month's payment
  const days = daysIn(key);
  return {
    B, rate, r, endKey, mLeft, io, custom, repayM, repayEndKey, repayLeft, applied, preB, days,
    repayPmt: ceil2(amRaw(B, repayM, r)),
    thisMonth: mLeft > 0 ? r2(preB * rate * days / 365) : (applied ? ceil2(amRaw(preB, Math.max(1, repayLeft), r)) : min.pmt),
    lo: r2(preB * rate * 28 / 365), hi: r2(preB * rate * 31 / 365),
    opts: opts.filter((o): o is HelocOption => !!o)
  };
}
export type HelocCalc = ReturnType<typeof helocCalc>;

/** If someone pays a custom amount that leaves a balance when repayment starts, what would the payment become? */
export function customWarning(c: HelocCalc): { kind: 'below-min'; min: number } | { kind: 'repay-jump'; owed: number; need: number; at: string } | null {
  const cu = c.custom;
  if (!(cu.pmt > 0) || cu.never || !cu.at) return null;
  if (cu.pmt < c.opts[0].pmt) return { kind: 'below-min', min: c.opts[0].pmt };
  if (c.mLeft && (cu.n || 0) > c.mLeft) {
    const owed = cu.at(c.mLeft), need = ceil2(amRaw(owed, c.repayM, c.r));
    if (cu.pmt < need) return { kind: 'repay-jump', owed, need, at: c.endKey };
  }
  return null;
}

/** Rule 5: interest = balance × APR × days in the month ÷ 365; the rest to principal. */
export function applyHeloc(m: Month, b: Bill, key: string): void {
  const h = m.heloc, B = Math.max(0, Number(h.balance) || 0), amt = Number(b.amount) || 0;
  const due = r2(B * (Number(h.rate) || 0) / 100 * daysIn(key) / 365);
  const interest = r2(Math.min(amt, due));
  const principal = r2(Math.min(B, Math.max(0, amt - interest)));
  h.balance = r2(B - principal);
  h.available = r2((Number(h.available) || 0) + principal);
  h.ytdInterest = r2((Number(h.ytdInterest) || 0) + interest);
  b.helocApplied = { interest, principal };
}

export function unapplyHeloc(m: Month, b: Bill): void {
  const a = b.helocApplied;
  if (!a) return;
  const h = m.heloc;
  h.balance = r2((Number(h.balance) || 0) + a.principal);
  h.available = r2((Number(h.available) || 0) - a.principal);
  h.ytdInterest = r2(Math.max(0, (Number(h.ytdInterest) || 0) - a.interest));
  b.helocApplied = null;
}

export class PlannerError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Rule 7: a draw adds to the account and the HELOC balance and lowers available credit, never past the limit. */
export function helocDraw(m: Month, acctId: string, amount: number, id = uid()): void {
  const h = m.heloc, a = m.accounts.find(x => x.id === acctId);
  const amt = r2(amount);
  if (!a) throw new PlannerError('That account isn’t in this month.', 404);
  if (!(amt > 0)) throw new PlannerError('Enter an amount to draw.');
  if (amt > (Number(h.available) || 0) + 0.001) throw new PlannerError(`Only $${(Number(h.available) || 0).toFixed(2)} is available on the HELOC.`, 422);
  a.balance = r2((Number(a.balance) || 0) + amt);
  h.balance = r2((Number(h.balance) || 0) + amt);
  h.available = r2((Number(h.available) || 0) - amt);
  h.draws.push({ id, acctId, amount: amt });
}

export function undoDraw(m: Month, id: string): void {
  const h = m.heloc, d = h.draws.find(x => x.id === id);
  if (!d) throw new PlannerError('That draw isn’t in this month.', 404);
  // Undoing after a HELOC payment already paid it down would leave a negative balance and quietly cancel that payment.
  if ((Number(h.balance) || 0) < d.amount - 0.001)
    throw new PlannerError('This month’s HELOC payment already paid part of that draw down. Uncheck the HELOC bill first, then undo the draw.', 422);
  const a = m.accounts.find(x => x.id === d.acctId);
  if (a) a.balance = r2((Number(a.balance) || 0) - d.amount);
  h.balance = r2((Number(h.balance) || 0) - d.amount);
  h.available = r2((Number(h.available) || 0) + d.amount);
  h.draws = h.draws.filter(x => x !== d);
}

/** Draw each short account's negative left-after-bills. Refuses the lot if the line can't cover all of it. */
export function coverShortfalls(m: Month, ids?: string[]): number {
  const short = shortfalls(m);
  const total = r2(short.reduce((t, x) => t + x.need, 0));
  if (total > (Number(m.heloc.available) || 0) + 0.001) throw new PlannerError('Not enough available credit to cover all of it.', 422);
  short.forEach((x, i) => helocDraw(m, x.account.id, x.need, ids?.[i]));
  return total;
}

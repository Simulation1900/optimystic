import type { Account, Bill, Month } from './types.js';
import { r2, sum } from './money.js';
import { PALETTE } from './defaults.js';

/** Bills on an account (null = unassigned), sorted by due day then name, as the planner shows them. */
export const billsFor = (m: Month, id: string | null): Bill[] =>
  m.bills
    .filter(b => (b.accountId || null) === id)
    .sort((a, b) => (a.dueDay || 99) - (b.dueDay || 99) || a.name.localeCompare(b.name));

export interface AccountStats { total: number; paid: number; due: number; dep: number; xferIn: number; xferOut: number; left: number }

/**
 * Rule 1: left after bills = balance + monthly deposit − every bill on the account, paid or not
 * (+ transfers in − transfers out, done or not).
 */
export function acctStats(m: Month, a: Account): AccountStats {
  const list = billsFor(m, a.id);
  const total = sum(list);
  const paid = sum(list.filter(b => b.paid));
  const dep = Number(a.deposit) || 0;
  const xfers = m.transfers || [];
  const xferIn = sum(xfers.filter(t => t.toId === a.id));
  const xferOut = sum(xfers.filter(t => t.fromId === a.id));
  // Same formula as the HTML planner (which had no transfers), so figures match it to the cent.
  return { total, paid, due: r2(total - paid), dep, xferIn, xferOut, left: r2((Number(a.balance) || 0) + dep - total + xferIn - xferOut) };
}

/** Accounts with money to spare after bills, most first: where a shortfall transfer could come from. */
export const surplusAccounts = (m: Month, except?: string) =>
  m.accounts.filter(a => a.id !== except).map(a => ({ account: a, left: acctStats(m, a).left })).filter(x => x.left > 0).sort((x, y) => y.left - x.left);

export interface MonthTotals {
  cash: number; deposits: number; bills: number; paid: number; due: number;
  unassigned: number; unassignedCount: number; left: number;
  accounts: Record<string, AccountStats>;
}

/** Household totals: left over = all balances + all deposits − all bills. */
export function monthTotals(m: Month): MonthTotals {
  const cash = r2(m.accounts.reduce((t, a) => t + Math.round((Number(a.balance) || 0) * 100), 0) / 100);
  const deposits = r2(m.accounts.reduce((t, a) => t + Math.round((Number(a.deposit) || 0) * 100), 0) / 100);
  const all = sum(m.bills), paid = sum(m.bills.filter(b => b.paid));
  const un = billsFor(m, null);
  return {
    cash, deposits, bills: all, paid, due: r2(all - paid), unassigned: sum(un), unassignedCount: un.length,
    left: r2(cash + deposits - all),
    accounts: Object.fromEntries(m.accounts.map(a => [a.id, acctStats(m, a)]))
  };
}

export interface Shortfall { account: Account; need: number }
/** Accounts whose left-after-bills is negative, and by how much. */
export const shortfalls = (m: Month): Shortfall[] =>
  m.accounts.map(a => ({ account: a, need: r2(-acctStats(m, a).left) })).filter(x => x.need > 0);

/** The "After drop" preview: what an account would have left if this bill moved onto it. */
export function leftAfterMove(m: Month, billId: string, acctId: string | null): number | null {
  const b = m.bills.find(x => x.id === billId);
  if (!b || acctId === null || (b.accountId || null) === acctId) return null;
  const a = m.accounts.find(x => x.id === acctId);
  if (!a) return null;
  return r2(acctStats(m, a).left - (Number(b.amount) || 0));
}

/** The first palette color no other account uses. */
export function nextColor(m: Month): string {
  const used = new Set(m.accounts.map(x => x.color).filter(Boolean));
  return PALETTE.find(c => !used.has(c)) || PALETTE[m.accounts.length % PALETTE.length];
}

/** Give every account a color, the same way the HTML planner did the first time it drew one. */
export function ensureColors(m: Month): void {
  m.accounts.forEach((a, i) => {
    if (!a.color) {
      const used = new Set(m.accounts.map(x => x.color).filter(Boolean));
      a.color = PALETTE.find(c => !used.has(c)) || PALETTE[i % PALETTE.length];
    }
  });
}

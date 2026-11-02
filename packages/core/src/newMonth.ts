import type { Bill, Month } from './types.js';
import { r2 } from './money.js';
import { acctStats } from './accounts.js';
import { budgetStats } from './budget.js';
import { clone, uid } from './ids.js';
import { PlannerError } from './heloc.js';

export type BalanceMode = 'forecast' | 'same' | 'zero';
export type CardBillMode = 'projected' | 'actual' | 'keep';

export interface NewMonthOptions {
  balances: BalanceMode;
  cardBills: CardBillMode;
  copyOneTime: boolean;
}

const strip = <T extends object>(o: T): T => {
  const c = { ...o } as Record<string, unknown>;
  delete c.version; delete c.updatedAt; delete c.updatedBy;
  return c as T;
};

/**
 * Rules 9 and 10. Copies recurring bills (one-time expenses only if asked), all unpaid. Starting balances are the
 * forecast (left after bills), the same, or $0. Loans and the HELOC carry their balances; HELOC draws start empty.
 * Each card's linked bill becomes projected spending, actual spending, or is left alone.
 */
export function buildNewMonth(src: Month, opts: NewMonthOptions, newId: () => string = uid): Month {
  if (src.cardOnly) throw new PlannerError('That month only tracks card spending. Copy from a month with your accounts and bills.');
  const fc = Object.fromEntries(src.accounts.map(a => [a.id, acctStats(src, a).left]));
  const s = clone(src);
  const out: Month = {
    accounts: s.accounts.map(a => strip({ ...a, balance: opts.balances === 'zero' ? 0 : opts.balances === 'forecast' ? fc[a.id] : a.balance })),
    bills: s.bills
      .filter(b => b.recurring || opts.copyOneTime)
      .map(b => strip({ ...b, id: newId(), paid: false, helocApplied: null, loanApplied: null, balanceApplied: null })),
    // Monthly transfers come along, not yet done; one-off transfers stay in their month.
    transfers: (s.transfers || []).filter(t => t.recurring).map(t => strip({ ...t, id: newId(), done: false })),
    loans: s.loans.map(strip),
    heloc: { ...strip(s.heloc), draws: [] },
    budget: { baseline: s.budget.baseline, cards: s.budget.cards.map(strip), cats: s.budget.cats.map(strip), expenses: [] }
  };
  if (opts.cardBills !== 'keep') {
    const cs = budgetStats(src);
    cs.cards.forEach(c => {
      if (!c.billName) return;
      const amt = opts.cardBills === 'actual' ? c.spent : c.projected;
      let bill = out.bills.find(x => x.name === c.billName);
      if (!bill) {
        bill = { id: newId(), name: c.billName, amount: 0, accountId: null, recurring: true, dueDay: null, paid: false } as Bill;
        out.bills.push(bill);
      }
      bill.amount = r2(amt);
    });
  }
  return out;
}

import type { Account, Bill, Transfer, BudgetCard, BudgetCategory, CardExpense, Heloc, Loan, LoanKind, Month } from './types.js';
import { cents, r2 } from './money.js';
import { monthBounds } from './dates.js';
import { nextColor, shortfalls as shortfallsFor } from './accounts.js';
import { PALETTE, newLoan } from './defaults.js';
import { PlannerError, coverShortfalls, helocBill, helocDraw, undoDraw } from './heloc.js';
import { syncPayment, unapplyAll, unapplyBalance } from './payments.js';
import { unapplyLoan } from './loans.js';

/**
 * Every change to a month is one of these. The server applies it to the stored month and the web app applies the
 * same op to its copy for an instant preview, so both always agree. `version` (optional) is the version of the row
 * the person was looking at; the server refuses the op with 409 if someone else changed that row first.
 */
export type Op =
  | { type: 'account.add'; id: string; name: string; balance?: number | string; deposit?: number | string; color?: string }
  | { type: 'account.update'; id: string; version?: number; patch: { name?: string; balance?: number | string; deposit?: number | string; color?: string } }
  | { type: 'account.remove'; id: string; version?: number }
  | { type: 'bill.add'; id: string; name: string; amount: number | string; accountId?: string | null; dueDay?: number | string | null; recurring?: boolean }
  | { type: 'bill.update'; id: string; version?: number; patch: { name?: string; amount?: number | string; accountId?: string | null; dueDay?: number | string | null; recurring?: boolean; paid?: boolean } }
  | { type: 'bill.remove'; id: string; version?: number }
  | { type: 'transfer.add'; id: string; fromId: string; toId: string; amount: number | string; note?: string; recurring?: boolean }
  | { type: 'transfer.update'; id: string; version?: number; patch: { fromId?: string; toId?: string; amount?: number | string; note?: string; recurring?: boolean; done?: boolean } }
  | { type: 'transfer.remove'; id: string; version?: number }
  | { type: 'loan.add'; id: string }
  | { type: 'loan.update'; id: string; version?: number; patch: Partial<Record<keyof Loan, unknown>> }
  | { type: 'loan.remove'; id: string; version?: number }
  | { type: 'loan.matchBill'; id: string }
  | { type: 'heloc.update'; version?: number; patch: Partial<Record<'limit' | 'rate' | 'start' | 'drawYears' | 'repayYears' | 'balance' | 'available' | 'ytdInterest' | 'customPmt', unknown>> }
  | { type: 'heloc.setBill'; amount: number | string; billId?: string }
  | { type: 'heloc.draw'; id: string; acctId: string; amount: number | string }
  | { type: 'heloc.undoDraw'; id: string }
  | { type: 'heloc.cover'; acctId?: string; ids?: string[] }
  | { type: 'budget.update'; version?: number; patch: { baseline?: number | string } }
  | { type: 'card.add'; id: string; name?: string }
  | { type: 'card.update'; id: string; version?: number; patch: { name?: string; billName?: string; color?: string; closeDay?: number | string | null; dueDay?: number | string | null } }
  | { type: 'card.remove'; id: string; version?: number }
  | { type: 'cat.add'; id: string; name?: string; limit?: number | string; cardId?: string }
  | { type: 'cat.update'; id: string; version?: number; patch: { name?: string; limit?: number | string; cardId?: string } }
  | { type: 'cat.remove'; id: string; version?: number }
  | { type: 'expense.add'; id: string; date: string; desc: string; amount: number | string; catId: string; cardId: string; source?: 'manual' | 'csv' | 'sync' }
  | { type: 'expense.update'; id: string; version?: number; patch: { date?: string; desc?: string; amount?: number | string; catId?: string; cardId?: string } }
  | { type: 'expense.remove'; id: string; version?: number };

export type OpType = Op['type'];

/** The table and row an op edits, for the server's version check. */
export function opTarget(op: Op): { table: 'accounts' | 'bills' | 'transfers' | 'loans' | 'heloc' | 'budget_cards' | 'budget_categories' | 'card_expenses' | 'months'; id: string } | null {
  const [kind] = op.type.split('.');
  const id = 'id' in op ? op.id : '';
  switch (kind) {
    case 'account': return { table: 'accounts', id };
    case 'bill': return { table: 'bills', id };
    case 'transfer': return { table: 'transfers', id };
    case 'loan': return { table: 'loans', id };
    case 'heloc': return op.type === 'heloc.update' ? { table: 'heloc', id: 'heloc' } : null;
    case 'budget': return { table: 'months', id: 'month' };
    case 'card': return { table: 'budget_cards', id };
    case 'cat': return { table: 'budget_categories', id };
    case 'expense': return { table: 'card_expenses', id };
  }
  return null;
}

/** The current version of the row an op targets, or undefined if it has none (new row). */
export function targetVersion(m: Month, op: Op): number | undefined {
  const t = opTarget(op);
  if (!t) return undefined;
  const find = <T extends { id: string; version?: number }>(list: T[]) => list.find(x => x.id === t.id)?.version;
  switch (t.table) {
    case 'accounts': return find(m.accounts);
    case 'bills': return find(m.bills);
    case 'transfers': return find(m.transfers);
    case 'loans': return find(m.loans);
    case 'heloc': return m.heloc.version;
    case 'months': return m.meta?.version;
    case 'budget_cards': return find(m.budget.cards);
    case 'budget_categories': return find(m.budget.cats);
    case 'card_expenses': return find(m.budget.expenses);
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const checkId = (id: unknown): string => {
  if (typeof id !== 'string' || !ID.test(id)) throw new PlannerError('Bad id.');
  return id;
};
const name = (v: unknown, keep: string, max = 120): string => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || keep;
};
const money = (v: unknown) => Math.abs(cents(v));
const plain = (v: unknown) => Math.max(0, parseFloat(String(v ?? '').replace(/[%,\s]/g, '')) || 0);
const signedPlain = (v: unknown) => parseFloat(String(v ?? '').replace(/[%,\s]/g, '')) || 0;
const color = (v: unknown, keep: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : keep);
const monthStr = (v: unknown, keep: string) => (typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : keep);
const dueDay = (v: unknown): number | null => {
  const n = parseInt(String(v ?? ''), 10);
  return n >= 1 && n <= 31 ? n : null;
};
const need = <T>(x: T | undefined, what: string): T => {
  if (!x) throw new PlannerError(`That ${what} isn’t in this month.`, 404);
  return x;
};
const fresh = (list: Array<{ id: string }>, id: string) => {
  if (list.some(x => x.id === id)) throw new PlannerError('That id is already used.', 409);
};

function setTransfer(m: Month, t: Transfer, v: { fromId?: string; toId?: string; amount?: unknown; note?: unknown }) {
  const from = need(m.accounts.find(a => a.id === v.fromId), 'account to transfer from');
  const to = need(m.accounts.find(a => a.id === v.toId), 'account to transfer to');
  if (from.id === to.id) throw new PlannerError('Pick two different accounts.');
  const amount = money(v.amount);
  if (!(amount > 0)) throw new PlannerError('Enter an amount to transfer.');
  t.fromId = from.id; t.toId = to.id; t.amount = amount;
  t.note = String(v.note ?? '').trim().slice(0, 120);
}

/**
 * Apply one op to a month in place. `key` is the month ('2026-11'); it matters for HELOC interest
 * (days in the month) and loan value dates. Throws PlannerError on anything invalid.
 */
export function applyOp(m: Month, key: string, op: Op): void {
  if (m.cardOnly && !/^(card|cat|expense|budget)\./.test(op.type)) throw new PlannerError('This month only tracks card spending.');
  switch (op.type) {
    /* ---------- accounts ---------- */
    case 'account.add': {
      const id = checkId(op.id); fresh(m.accounts, id);
      const n = name(op.name, '');
      if (!n) throw new PlannerError('Give the account a name.');
      const a: Account = { id, name: n, balance: cents(op.balance), deposit: money(op.deposit), color: '' };
      a.color = color(op.color, nextColor(m));
      m.accounts.push(a);
      return;
    }
    case 'account.update': {
      const a = need(m.accounts.find(x => x.id === op.id), 'account'), p = op.patch || {};
      if ('name' in p) a.name = name(p.name, a.name);
      if ('balance' in p) a.balance = cents(p.balance);
      if ('deposit' in p) a.deposit = money(p.deposit);
      if ('color' in p) a.color = color(p.color, a.color || nextColor(m));
      return;
    }
    case 'account.remove': {
      const a = need(m.accounts.find(x => x.id === op.id), 'account');
      m.bills.forEach(b => { if (b.accountId === a.id) { unapplyBalance(m, b); b.accountId = null; } });
      m.transfers = m.transfers.filter(t => t.fromId !== a.id && t.toId !== a.id);
      m.accounts = m.accounts.filter(x => x !== a);
      return;
    }

    /* ---------- transfers ---------- */
    case 'transfer.add': {
      const id = checkId(op.id); fresh(m.transfers, id);
      const t: Transfer = { id, fromId: '', toId: '', amount: 0, note: '', recurring: !!op.recurring, done: false };
      setTransfer(m, t, { fromId: op.fromId, toId: op.toId, amount: op.amount, note: op.note });
      m.transfers.push(t);
      return;
    }
    case 'transfer.update': {
      const t = need(m.transfers.find(x => x.id === op.id), 'transfer'), p = op.patch || {};
      setTransfer(m, t, { fromId: p.fromId ?? t.fromId, toId: p.toId ?? t.toId, amount: 'amount' in p ? p.amount : t.amount, note: 'note' in p ? p.note : t.note });
      if ('recurring' in p) t.recurring = !!p.recurring;
      if ('done' in p) t.done = !!p.done;
      return;
    }
    case 'transfer.remove': {
      need(m.transfers.find(x => x.id === op.id), 'transfer');
      m.transfers = m.transfers.filter(x => x.id !== op.id);
      return;
    }

    /* ---------- bills ---------- */
    case 'bill.add': {
      const id = checkId(op.id); fresh(m.bills, id);
      const n = name(op.name, '');
      if (!n) throw new PlannerError('Give the bill a name.');
      const acct = op.accountId || null;
      if (acct) need(m.accounts.find(x => x.id === acct), 'account');
      const b: Bill = { id, name: n, amount: money(op.amount), accountId: acct, dueDay: dueDay(op.dueDay), recurring: op.recurring !== false, paid: false };
      m.bills.push(b);
      syncPayment(m, b, key);
      return;
    }
    case 'bill.update': {
      const b = need(m.bills.find(x => x.id === op.id), 'bill'), p = op.patch || {};
      if ('name' in p) b.name = name(p.name, b.name);
      if ('amount' in p) b.amount = money(p.amount);
      if ('accountId' in p) {
        const acct = p.accountId || null;
        if (acct) need(m.accounts.find(x => x.id === acct), 'account');
        b.accountId = acct;
      }
      if ('dueDay' in p) b.dueDay = dueDay(p.dueDay);
      if ('recurring' in p) b.recurring = !!p.recurring;
      if ('paid' in p) b.paid = !!p.paid;
      syncPayment(m, b, key);
      return;
    }
    case 'bill.remove': {
      const b = need(m.bills.find(x => x.id === op.id), 'bill');
      unapplyAll(m, b);
      m.bills = m.bills.filter(x => x !== b);
      return;
    }

    /* ---------- loans ---------- */
    case 'loan.add': {
      const id = checkId(op.id); fresh(m.loans, id);
      m.loans.push(newLoan(id, key));
      return;
    }
    case 'loan.update': {
      const l = need(m.loans.find(x => x.id === op.id), 'loan'), p = op.patch || {};
      let relink = false;
      for (const [k, v] of Object.entries(p)) {
        switch (k as keyof Loan) {
          case 'name': l.name = name(v, l.name); break;
          case 'lender': l.lender = String(v ?? '').trim().slice(0, 120); break;
          case 'vin': l.vin = String(v ?? '').trim().toUpperCase().slice(0, 32); break;
          case 'kind': if (['car', 'home', 'other'].includes(String(v))) { l.kind = v as LoanKind; relink = true; } break;
          case 'billName': l.billName = String(v ?? '').slice(0, 120); relink = true; break;
          case 'open': l.open = v === '' ? '' : monthStr(v, l.open); break;
          case 'balance': case 'payment': case 'escrow': case 'original': case 'purchasePrice': case 'customPmt':
            (l as unknown as Record<string, number>)[k] = money(v); break;
          case 'value': l.value = money(v); l.valueAsOf = key; l.valueEstimated = false; break;
          case 'rate': case 'term': (l as unknown as Record<string, number>)[k] = plain(v); break;
          case 'valueRate': l.valueRate = signedPlain(v); break;
          default: break; // valueAsOf, valueEstimated, id: not editable directly
        }
      }
      if (relink) m.bills.forEach(b => syncPayment(m, b, key));
      return;
    }
    case 'loan.remove': {
      const l = need(m.loans.find(x => x.id === op.id), 'loan');
      m.bills.forEach(b => { if (b.loanApplied && b.loanApplied.loanId === l.id) unapplyLoan(m, b); });
      m.loans = m.loans.filter(x => x !== l);
      return;
    }
    case 'loan.matchBill': {
      const l = need(m.loans.find(x => x.id === op.id), 'loan');
      const b = need(m.bills.find(x => x.name.trim().toLowerCase() === l.billName.trim().toLowerCase() && !!l.billName), 'linked bill');
      b.amount = r2(Number(l.payment) || 0);
      syncPayment(m, b, key);
      return;
    }

    /* ---------- HELOC ---------- */
    case 'heloc.update': {
      const h = m.heloc, p = op.patch || {};
      for (const [k, v] of Object.entries(p)) {
        switch (k as keyof Heloc) {
          case 'rate': case 'drawYears': case 'repayYears': (h as unknown as Record<string, number>)[k] = plain(v); break;
          case 'limit': case 'balance': case 'available': case 'ytdInterest': case 'customPmt':
            (h as unknown as Record<string, number>)[k] = money(v); break;
          case 'start': h.start = monthStr(v, h.start); break;
          default: break;
        }
      }
      return;
    }
    case 'heloc.setBill': {
      let b = helocBill(m);
      if (!b) {
        const id = checkId(op.billId); fresh(m.bills, id);
        b = { id, name: 'HELOC', amount: 0, accountId: null, recurring: true, dueDay: null, paid: false };
        m.bills.push(b);
      }
      b.amount = r2(money(op.amount));
      syncPayment(m, b, key);
      return;
    }
    case 'heloc.draw': {
      const id = checkId(op.id); fresh(m.heloc.draws, id);
      helocDraw(m, op.acctId, money(op.amount), id);
      return;
    }
    case 'heloc.undoDraw': undoDraw(m, op.id); return;
    case 'heloc.cover': {
      (op.ids || []).forEach(checkId);
      if (op.acctId) {
        const x = need(shortfallsFor(m).find(s => s.account.id === op.acctId), 'short account');
        const id = checkId(op.ids?.[0]); fresh(m.heloc.draws, id);
        helocDraw(m, x.account.id, x.need, id);
      } else {
        const ids = op.ids || [];
        if (ids.length < shortfallsFor(m).length) throw new PlannerError('Missing draw ids.');
        coverShortfalls(m, ids);
      }
      return;
    }

    /* ---------- card budget ---------- */
    case 'budget.update': {
      if ('baseline' in (op.patch || {})) m.budget.baseline = money(op.patch.baseline);
      return;
    }
    case 'card.add': {
      const id = checkId(op.id); fresh(m.budget.cards, id);
      const c: BudgetCard = { id, name: name(op.name, 'New card'), billName: '', color: PALETTE[m.budget.cards.length % PALETTE.length] };
      m.budget.cards.push(c);
      return;
    }
    case 'card.update': {
      const c = need(m.budget.cards.find(x => x.id === op.id), 'card'), p = op.patch || {};
      if ('name' in p) c.name = name(p.name, c.name);
      if ('billName' in p) c.billName = String(p.billName ?? '').slice(0, 120);
      if ('color' in p) c.color = color(p.color, c.color);
      if ('closeDay' in p) c.closeDay = dueDay(p.closeDay);
      if ('dueDay' in p) c.dueDay = dueDay(p.dueDay);
      return;
    }
    case 'card.remove': {
      const b = m.budget, c = need(b.cards.find(x => x.id === op.id), 'card');
      if (b.cards.length <= 1) throw new PlannerError('Keep at least one card.', 422);
      const to = b.cards.find(x => x.id !== c.id)!;
      b.cards = b.cards.filter(x => x.id !== c.id);
      b.expenses.forEach(x => { if (x.cardId === c.id) x.cardId = to.id; });
      b.cats.forEach(x => { if (x.cardId === c.id) x.cardId = to.id; });
      return;
    }
    case 'cat.add': {
      const id = checkId(op.id); fresh(m.budget.cats, id);
      const cardId = op.cardId && m.budget.cards.some(c => c.id === op.cardId) ? op.cardId : (m.budget.cards[0]?.id || '');
      const k: BudgetCategory = { id, name: name(op.name, 'New category'), limit: money(op.limit), cardId };
      m.budget.cats.push(k);
      return;
    }
    case 'cat.update': {
      const k = need(m.budget.cats.find(x => x.id === op.id), 'category'), p = op.patch || {};
      if ('name' in p) k.name = name(p.name, k.name);
      if ('limit' in p) k.limit = money(p.limit);
      if ('cardId' in p) k.cardId = need(m.budget.cards.find(c => c.id === p.cardId), 'card').id;
      return;
    }
    case 'cat.remove': {
      const b = m.budget, k = need(b.cats.find(x => x.id === op.id), 'category');
      b.cats = b.cats.filter(x => x !== k);
      const to = b.cats.find(x => x.name.toLowerCase() === 'other') || b.cats[0];
      b.expenses.forEach(x => { if (x.catId === k.id && to) x.catId = to.id; });
      return;
    }
    case 'expense.add': {
      const id = checkId(op.id); fresh(m.budget.expenses, id);
      const desc = name(op.desc, '', 200), amount = cents(op.amount);
      const { first, last } = monthBounds(key);
      if (!desc) throw new PlannerError('Give the expense a description.');
      if (!amount) throw new PlannerError('Enter an amount.');
      if (!(typeof op.date === 'string' && op.date >= first && op.date <= last && /^\d{4}-\d{2}-\d{2}$/.test(op.date)))
        throw new PlannerError('The date has to be in this month.');
      const cat = need(m.budget.cats.find(x => x.id === op.catId), 'category');
      const card = need(m.budget.cards.find(x => x.id === op.cardId), 'card');
      const source = op.source === 'csv' || op.source === 'sync' ? op.source : 'manual';
      const e: CardExpense = { id, date: op.date, desc, amount, catId: cat.id, cardId: card.id, source, catChosen: source === 'manual' };
      m.budget.expenses.push(e);
      return;
    }
    case 'expense.update': {
      const e = need(m.budget.expenses.find(x => x.id === op.id), 'expense'), p = op.patch || {};
      if ('desc' in p) e.desc = name(p.desc, e.desc, 200);
      if ('amount' in p) { const a = cents(p.amount); if (a) e.amount = a; }
      if ('catId' in p) { e.catId = need(m.budget.cats.find(x => x.id === p.catId), 'category').id; e.catChosen = true; }
      if ('cardId' in p) e.cardId = need(m.budget.cards.find(x => x.id === p.cardId), 'card').id;
      if ('date' in p) {
        const { first, last } = monthBounds(key);
        if (typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date >= first && p.date <= last) e.date = p.date;
        else throw new PlannerError('The date has to be in this month.');
      }
      return;
    }
    case 'expense.remove': {
      need(m.budget.expenses.find(x => x.id === op.id), 'expense');
      m.budget.expenses = m.budget.expenses.filter(x => x.id !== op.id);
      return;
    }
    default: {
      const t: never = op;
      throw new PlannerError(`Unknown change “${(t as { type: string }).type}”.`);
    }
  }
}

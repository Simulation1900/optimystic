import type { Budget, Heloc, Loan, Month, PlannerState } from './types.js';
import { clone } from './ids.js';

export const PALETTE = ['#5c8a72', '#8a6fae', '#c0834f', '#4f80a8', '#b0606f', '#7f9a45', '#3f8f8f', '#a07a3c'];

export const helocDefault = (): Heloc => ({
  limit: 80000, rate: 8, start: '2025-05', drawYears: 10, repayYears: 10,
  balance: 0, available: 80000, ytdInterest: 0, customPmt: 0, draws: []
});

const CATS: Array<[string, number, string]> = [
  ['Groceries', 1300, 'card-boa'], ['Gas', 250, 'card-boa'], ['Kids activities', 120, 'card-boa'],
  ['Amazon', 200, 'card-chase'], ['Clothes, kids & gifts', 125, 'card-chase'], ['Dining out', 100, 'card-chase'],
  ['Coffee & snacks', 40, 'card-chase'], ['Subscriptions', 156, 'card-chase'], ['Supplements', 40, 'card-chase'],
  ['Home & hardware', 50, 'card-chase'], ['Health & pharmacy', 85, 'card-chase'], ['Travel & big purchases', 200, 'card-chase'],
  ['Donations', 25, 'card-chase'], ['Other', 50, 'card-chase']
];

export const catIdFor = (name: string) => 'cat-' + name.toLowerCase().replace(/[^a-z]+/g, '-');

export const budgetDefault = (): Budget => ({
  baseline: 4537,
  cards: [
    { id: 'card-boa', name: 'BoA Visa', billName: 'BoA Credit Bill', color: '#c0834f' },
    { id: 'card-chase', name: 'Chase', billName: 'Chase Credit Bill', color: '#4f80a8' }
  ],
  cats: CATS.map(([name, limit, cardId]) => ({ id: catIdFor(name), name, limit, cardId })),
  expenses: []
});

export const emptyMonth = (): Month => ({ accounts: [], bills: [], transfers: [], loans: [], heloc: helocDefault(), budget: budgetDefault() });

export const newLoan = (id: string, valueAsOf: string): Loan => ({
  id, kind: 'car', name: 'New loan', lender: '', balance: 0, rate: 0, payment: 0, escrow: 0, original: 0, open: '', term: 0,
  vin: '', purchasePrice: 0, value: 0, valueAsOf, valueRate: -15, valueEstimated: false, billName: '', customPmt: 0
});

const n = (v: unknown, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v) || 0);
const s = (v: unknown, d = '') => (v === null || v === undefined ? d : String(v));

/**
 * Fill in anything an older planner version left out, the same way the HTML planner did when it
 * opened a month (H(), L(), BG()). Returns a new object; the input isn't touched.
 */
export function normalizeMonth(raw: Partial<Month> | undefined, key: string): Month {
  const m = clone(raw || {}) as Partial<Month>;
  const accounts = (Array.isArray(m.accounts) ? m.accounts : []).map(a => ({
    ...a, id: s(a.id), name: s(a.name), balance: n(a.balance), deposit: n(a.deposit), ...(a.color ? { color: a.color } : {})
  }));
  const bills = (Array.isArray(m.bills) ? m.bills : []).map(b => ({
    ...b, id: s(b.id), name: s(b.name), amount: n(b.amount), accountId: b.accountId || null,
    recurring: !!b.recurring, dueDay: b.dueDay ? Number(b.dueDay) || null : null, paid: !!b.paid,
    helocApplied: b.helocApplied || null, loanApplied: b.loanApplied || null, balanceApplied: b.balanceApplied || null
  }));
  const loans: Loan[] = (Array.isArray(m.loans) ? m.loans : []).map(l => ({
    ...l, id: s(l.id), kind: (['car', 'home', 'other'].includes(l.kind) ? l.kind : 'car'), name: s(l.name), lender: s(l.lender),
    balance: n(l.balance), rate: n(l.rate), payment: n(l.payment), escrow: n(l.escrow), original: n(l.original),
    open: s(l.open), term: n(l.term), vin: s(l.vin), purchasePrice: n(l.purchasePrice), value: n(l.value),
    valueAsOf: s(l.valueAsOf, key), valueRate: n(l.valueRate), valueEstimated: !!l.valueEstimated,
    billName: s(l.billName), customPmt: n(l.customPmt)
  }));
  // Same one-off fixes the HTML planner applied when it opened its loans.
  const mg = loans.find(l => l.id === 'mortgage');
  if (mg && !mg.open && !mg.original && !mg.term) Object.assign(mg, { original: 249400, open: '2020-12', term: 360 });
  const es = loans.find(l => l.id === 'escape');
  if (es && es.valueEstimated && [21000, 28000, 28500].includes(es.value)) es.value = 29500;

  const hd = helocDefault();
  const h = (m.heloc || {}) as Partial<Heloc>;
  const heloc: Heloc = {
    ...h,
    limit: n(h.limit, hd.limit), rate: n(h.rate, hd.rate), start: s(h.start, hd.start) || hd.start,
    drawYears: n(h.drawYears, hd.drawYears), repayYears: n(h.repayYears, hd.repayYears),
    balance: n(h.balance), available: n(h.available, hd.available), ytdInterest: n(h.ytdInterest), customPmt: n(h.customPmt),
    draws: (Array.isArray(h.draws) ? h.draws : []).map(d => ({ ...d, id: s(d.id), acctId: s(d.acctId), amount: n(d.amount) }))
  };

  const bd = budgetDefault();
  const b = (m.budget || bd) as Partial<Budget>;
  const budget: Budget = {
    baseline: b.baseline === null || b.baseline === undefined ? 4537 : n(b.baseline),
    cards: (Array.isArray(b.cards) ? b.cards : []).map(c => ({ ...c, id: s(c.id), name: s(c.name), billName: s(c.billName), color: s(c.color) })),
    cats: (Array.isArray(b.cats) ? b.cats : []).map(c => ({ ...c, id: s(c.id), name: s(c.name), limit: n(c.limit), cardId: s(c.cardId) })),
    expenses: (Array.isArray(b.expenses) ? b.expenses : []).map(e => ({
      ...e, id: s(e.id), date: s(e.date), desc: s(e.desc), amount: n(e.amount), catId: s(e.catId), cardId: s(e.cardId),
      // The HTML planner didn't record a source; its expenses were entered or kept by a person, so they count as chosen.
      source: e.source === 'csv' || e.source === 'sync' ? e.source : 'manual',
      catChosen: typeof e.catChosen === 'boolean' ? e.catChosen : !(e.source === 'csv' || e.source === 'sync')
    }))
  };
  const ids = new Set(accounts.map(a => a.id));
  const transfers = (Array.isArray(m.transfers) ? m.transfers : [])
    .map(t => ({ ...t, id: s(t.id), fromId: s(t.fromId), toId: s(t.toId), amount: n(t.amount), note: s(t.note), recurring: !!t.recurring, done: !!t.done }))
    .filter(t => ids.has(t.fromId) && ids.has(t.toId) && t.fromId !== t.toId);
  const out: Month = { accounts, bills, transfers, loans, heloc, budget };
  if (m.meta) out.meta = m.meta;
  return out;
}

export const validState = (s: unknown): s is PlannerState => {
  const x = s as PlannerState;
  return !!(x && typeof x === 'object' && x.current && x.months && typeof x.months === 'object' && x.months[x.current]);
};

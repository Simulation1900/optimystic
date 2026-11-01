// One block per rule in the spec's Business rules section.
import { describe, expect, it } from 'vitest';
import {
  acctStats, applyOp, budgetStats, buildNewMonth, coverShortfalls, emptyMonth, helocCalc, importCardItems, leftAfterMove,
  loanCalc, monthTotals, parseCardCSV, readBackup, shortfalls, toBackup, PlannerError, type Month
} from '../src/index.js';
import { fixture, sampleMonth, sampleState, seqId } from './helpers.js';

const K = '2026-11';
const acct = (m: Month, id: string) => m.accounts.find(a => a.id === id)!;
const bill = (m: Month, id: string) => m.bills.find(b => b.id === id)!;

describe('rule 1: account math', () => {
  it('left after bills = balance + deposit − every bill on the account, paid or not', () => {
    const m = sampleMonth();
    expect(acctStats(m, acct(m, 'chk1'))).toEqual({ total: 758.24, paid: 120, due: 638.24, dep: 1500, left: 1321.76 });
    expect(acctStats(m, acct(m, 'chk2')).left).toBe(470.37);
    expect(acctStats(m, acct(m, 'sav1')).left).toBe(-600);
  });
  it('household left over = all balances + all deposits − all bills (unassigned included)', () => {
    const t = monthTotals(sampleMonth());
    expect(t).toMatchObject({ cash: 1000, deposits: 3500, bills: 3323.86, paid: 120, due: 3203.86, unassigned: 15.99, unassignedCount: 1, left: 1176.14 });
  });
  it('previews the left-over after a move', () => {
    const m = sampleMonth();
    expect(leftAfterMove(m, 'b-tv', 'chk2')).toBe(454.38);
    expect(leftAfterMove(m, 'b-tv', null)).toBeNull();
  });
});

describe('rule 2: paid is a marker', () => {
  it('checking an ordinary bill never changes a balance', () => {
    const m = sampleMonth();
    const before = JSON.stringify(m.accounts);
    applyOp(m, K, { type: 'bill.update', id: 'b-card', patch: { paid: true } });
    expect(JSON.stringify(m.accounts)).toBe(before);
    expect(bill(m, 'b-card')).toMatchObject({ paid: true, loanApplied: null, helocApplied: null });
  });
});

describe('rule 3: loan bills apply their payment, and every change reverses exactly', () => {
  it('mortgage: check, edit the amount, uncheck, delete', () => {
    const m = sampleMonth(), l = () => m.loans.find(x => x.id === 'mortgage')!;
    applyOp(m, K, { type: 'bill.update', id: 'b-mort', patch: { paid: true } });
    expect(l().balance).toBe(215531.12);
    applyOp(m, K, { type: 'bill.update', id: 'b-mort', patch: { amount: 1749.63 } });
    expect(bill(m, 'b-mort').loanApplied).toMatchObject({ principal: 623.03 });
    expect(l().balance).toBe(215431.12);
    applyOp(m, K, { type: 'bill.update', id: 'b-mort', patch: { paid: false } });
    expect(l().balance).toBe(216054.15);
    applyOp(m, K, { type: 'bill.update', id: 'b-mort', patch: { paid: true } });
    applyOp(m, K, { type: 'bill.remove', id: 'b-mort' });
    expect(l().balance).toBe(216054.15);
  });
  it('HELOC: interest to YTD, principal raises available credit, reversed on uncheck', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'bill.update', id: 'b-heloc', patch: { amount: 500 } });
    applyOp(m, K, { type: 'bill.update', id: 'b-heloc', patch: { paid: true } });
    expect(bill(m, 'b-heloc').helocApplied).toEqual({ interest: 361.66, principal: 138.34 });
    expect(m.heloc).toMatchObject({ balance: 54863.48, available: 25136.52, ytdInterest: 3361.66 });
    applyOp(m, K, { type: 'bill.update', id: 'b-heloc', patch: { paid: false } });
    expect(m.heloc).toMatchObject({ balance: 55001.82, available: 24998.18, ytdInterest: 3000 });
  });
  it('relinking a loan to another bill moves the application', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'bill.update', id: 'b-car', patch: { paid: true } });
    expect(m.loans[0].balance).toBeLessThan(3922.35);
    applyOp(m, K, { type: 'loan.update', id: 'car1', patch: { billName: '' } });
    expect(m.loans[0].balance).toBe(3922.35);
    expect(bill(m, 'b-car').loanApplied).toBeNull();
  });
  it('removing a loan puts back what its bills applied', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'bill.update', id: 'b-car', patch: { paid: true } });
    applyOp(m, K, { type: 'loan.remove', id: 'car1' });
    expect(bill(m, 'b-car').loanApplied).toBeNull();
  });
});

describe('rule 4: loan payment split', () => {
  it('never more than the balance', () => {
    const m = sampleMonth();
    m.loans[0].balance = 100;
    applyOp(m, K, { type: 'bill.update', id: 'b-car', patch: { paid: true } });
    expect(bill(m, 'b-car').loanApplied).toMatchObject({ interest: 0.39, principal: 100 });
    expect(m.loans[0].balance).toBe(0);
  });
});

describe('rule 5 and 6: HELOC schedule', () => {
  it('interest-only during the draw period, with options', () => {
    const c = helocCalc(sampleMonth(), K);
    expect(c.mLeft).toBe(102); // Nov 2026 → draw ends May 2035
    expect(c.endKey).toBe('2035-05');
    expect(c.io).toBe(366.68);
    expect(c.opts.map(o => o.key)).toEqual(['min', 'draw', 'y5', 'y3']);
    expect(c.opts[0].pmt2).toBe(667.33);
    c.opts.forEach(o => expect(Math.round(o.pmt * 100)).toBe(o.pmt * 100));
  });
  it('a month in the repayment period pays principal and interest', () => {
    const c = helocCalc(sampleMonth(), '2036-01');
    expect(c.mLeft).toBe(0);
    expect(c.opts[0].pmt2).toBeNull();
    expect(c.opts.map(o => o.key)).toEqual(['min', 'y5', 'y3']);
  });
  it('custom payment: payoff, or never if it doesn’t cover interest', () => {
    const m = sampleMonth();
    m.heloc.customPmt = 300;
    expect(helocCalc(m, K).custom.never).toBe(true);
    m.heloc.customPmt = 1500;
    const cu = helocCalc(m, K).custom;
    expect(cu.n).toBeGreaterThan(40);
    expect(cu.payoff).toMatch(/^20\d\d-\d\d$/);
  });
});

describe('rule 7: HELOC draws', () => {
  it('draws, undoes and refuses past the limit', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'heloc.draw', id: 'd1', acctId: 'chk1', amount: 1000 });
    expect(acct(m, 'chk1').balance).toBe(1580);
    expect(m.heloc).toMatchObject({ balance: 56001.82, available: 23998.18 });
    expect(() => applyOp(m, K, { type: 'heloc.draw', id: 'd2', acctId: 'chk1', amount: 30000 })).toThrow(PlannerError);
    applyOp(m, K, { type: 'heloc.undoDraw', id: 'd1' });
    expect(acct(m, 'chk1').balance).toBe(580);
    expect(m.heloc).toMatchObject({ balance: 55001.82, available: 24998.18, draws: [] });
  });
  it('cover shortfalls draws each negative left-after-bills', () => {
    const m = sampleMonth();
    expect(shortfalls(m).map(s => [s.account.id, s.need])).toEqual([['sav1', 600]]);
    applyOp(m, K, { type: 'heloc.cover', ids: ['c1'] });
    expect(acctStats(m, acct(m, 'sav1')).left).toBe(0);
    expect(shortfalls(m)).toEqual([]);
    expect(m.heloc.draws).toEqual([{ id: 'c1', acctId: 'sav1', amount: 600 }]);
  });
  it('refuses to cover when the line can’t take all of it', () => {
    const m = sampleMonth();
    m.heloc.available = 100;
    expect(() => coverShortfalls(m, ['x'])).toThrow(/Not enough/);
  });
});

describe('rule 8: loans', () => {
  it('payoff, equity and the contract check', () => {
    const m = sampleMonth(), c = loanCalc(m, m.loans[0], K);
    expect(c.opts[0]).toMatchObject({ n: 15, payoff: '2028-01' });
    expect(c.opts.map(o => o.name)).toEqual(['Current payment', 'Pay $50 more', 'Pay $100 more']);
    expect(c.equity).toBe(8577.65);
    expect(c.sched).toMatchObject({ made: 59, left: 13, first: '2021-12', last: '2027-11', pmt: 276.58 });
    const h = loanCalc(m, m.loans[1], K);
    expect(h.opts.map(o => o.name)).toEqual(['Current payment', 'Pay $100 more', 'Pay $250 more']);
    expect(h.equity).toBe(133945.85);
  });
  it('a payment below the interest never pays off', () => {
    const m = sampleMonth();
    m.loans[0].payment = 10;
    expect(loanCalc(m, m.loans[0], K).opts[0].never).toBe(true);
  });
});

describe('rule 9 and 10: new month', () => {
  it('copies recurring bills unpaid, forecasts balances, carries loans and HELOC, empties draws and expenses', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'bill.update', id: 'b-mort', patch: { paid: true } });
    applyOp(m, K, { type: 'heloc.draw', id: 'd1', acctId: 'sav1', amount: 600 });
    applyOp(m, K, { type: 'expense.add', id: 'e1', date: '2026-11-03', desc: 'KROGER', amount: 50, catId: 'cat-groceries', cardId: 'card-boa' });
    const nm = buildNewMonth(m, { balances: 'forecast', cardBills: 'keep', copyOneTime: false }, seqId);
    expect(nm.accounts.map(a => a.balance)).toEqual([1321.76, 470.37, 0]);
    expect(nm.bills.some(b => b.name === 'Birthday gift')).toBe(false);
    expect(nm.bills.every(b => !b.paid && !b.loanApplied && !b.helocApplied)).toBe(true);
    expect(nm.loans.find(l => l.id === 'mortgage')!.balance).toBe(215531.12);
    expect(nm.heloc).toMatchObject({ balance: 55601.82, draws: [] });
    expect(nm.budget.expenses).toEqual([]);
    expect(nm.budget.cats).toHaveLength(14);
    expect(buildNewMonth(m, { balances: 'same', cardBills: 'keep', copyOneTime: true }, seqId).bills).toHaveLength(7);
    expect(buildNewMonth(m, { balances: 'zero', cardBills: 'keep', copyOneTime: false }, seqId).accounts.every(a => a.balance === 0)).toBe(true);
  });
  it('card bills become projected or actual spending, or are left alone', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'expense.add', id: 'e1', date: '2026-11-03', desc: 'Amazon', amount: 250, catId: 'cat-amazon', cardId: 'card-chase' });
    const st = budgetStats(m);
    const chase = st.cards.find(c => c.id === 'card-chase')!;
    expect(chase).toMatchObject({ spent: 250, budget: 1071, projected: 1121 }); // Amazon is over by 50, so only the other categories add
    const proj = buildNewMonth(m, { balances: 'same', cardBills: 'projected', copyOneTime: false }, seqId);
    expect(proj.bills.find(b => b.name === 'Chase Credit Bill')!.amount).toBe(1121);
    expect(proj.bills.find(b => b.name === 'BoA Credit Bill')).toMatchObject({ amount: 1670, accountId: null });
    const act = buildNewMonth(m, { balances: 'same', cardBills: 'actual', copyOneTime: false }, seqId);
    expect(act.bills.find(b => b.name === 'Chase Credit Bill')!.amount).toBe(250);
    const keep = buildNewMonth(m, { balances: 'same', cardBills: 'keep', copyOneTime: false }, seqId);
    expect(keep.bills.find(b => b.name === 'Chase Credit Bill')!.amount).toBe(900);
  });
});

describe('rule 11: card budget', () => {
  it('returns count negative; a card’s spent is what was placed on it', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'expense.add', id: 'e1', date: '2026-11-03', desc: 'Kroger', amount: 100, catId: 'cat-groceries', cardId: 'card-chase' });
    applyOp(m, K, { type: 'expense.add', id: 'e2', date: '2026-11-04', desc: 'Kroger return', amount: -20, catId: 'cat-groceries', cardId: 'card-chase' });
    const st = budgetStats(m);
    expect(st.byCat['cat-groceries']).toBe(80);
    expect(st.cards.find(c => c.id === 'card-chase')!.spent).toBe(80);
    expect(st.cards.find(c => c.id === 'card-boa')!.spent).toBe(0);
    expect(st).toMatchObject({ spent: 80, limit: 2741, left: 2661 });
  });
  it('expenses must be dated in their month', () => {
    const m = sampleMonth();
    expect(() => applyOp(m, K, { type: 'expense.add', id: 'e1', date: '2026-10-31', desc: 'x', amount: 1, catId: 'cat-gas', cardId: 'card-boa' })).toThrow(/this month/);
  });
  it('removing a category moves its expenses to Other; removing a card moves them to the next card', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'expense.add', id: 'e1', date: '2026-11-03', desc: 'x', amount: 5, catId: 'cat-gas', cardId: 'card-boa' });
    applyOp(m, K, { type: 'cat.remove', id: 'cat-gas' });
    expect(m.budget.expenses[0].catId).toBe('cat-other');
    applyOp(m, K, { type: 'card.remove', id: 'card-boa' });
    expect(m.budget.expenses[0].cardId).toBe('card-chase');
    expect(m.budget.cats.every(c => c.cardId === 'card-chase')).toBe(true);
    expect(() => applyOp(m, K, { type: 'card.remove', id: 'card-chase' })).toThrow(/at least one/);
  });
});

describe('rule 12: CSV import', () => {
  it('skips payments, flips signs, files by month, guesses categories, counts what it skipped', () => {
    const p = parseCardCSV(fixture('sample-card-activity.csv'));
    if (!p.ok) throw new Error(p.error);
    expect(p.items).toHaveLength(11);
    expect(p.items.find(i => i.desc === 'Amazon.com')!.amount).toBe(-15);
    expect(p.items.find(i => i.desc.startsWith('LOWES'))!.desc).toBe('LOWES #00001*, AISLE 3');
    const st = sampleState();
    st.months['2026-10'] = buildNewMonth(st.months['2026-11'], { balances: 'same', cardBills: 'keep', copyOneTime: false }, seqId);
    const r = importCardItems(st.months, p.items, 'card-chase', st.months['2026-11'], seqId);
    expect(r).toMatchObject({ added: 10, dup: 0, skipped: 1, months: ['2026-10', '2026-11'] });
    expect(r.message).toBe('✓ Added 10 expenses to October 2026, November 2026. 1 skipped (no planner month for their date — create that month first).');
    const oct = st.months['2026-10'].budget;
    expect(budgetStats(st.months['2026-10']).spent).toBe(96.54);
    expect(oct.expenses.find(e => e.desc.startsWith('SHELL'))!.catId).toBe('cat-gas');
    expect(oct.expenses.find(e => e.desc.startsWith('WALGREENS'))!.catId).toBe('cat-health-pharmacy');
    expect(oct.expenses.find(e => e.desc === 'SAMPLE GENERAL STORE')!.catId).toBe('cat-other');
    expect(oct.expenses.every(e => e.source === 'csv')).toBe(true);
    expect(budgetStats(st.months['2026-11']).spent).toBe(125.54);
    expect(importCardItems(st.months, p.items, 'card-chase', st.months['2026-11'], seqId)).toMatchObject({ added: 0, dup: 10, skipped: 1 });
  });
  it('reads debit/credit columns and positive-purchase files', () => {
    const p = parseCardCSV('Posted Date,Payee,Debit,Credit\n2026-11-02,KROGER,45.10,\n2026-11-03,REFUND,,5.00\n2026-11-04,BA ELECTRONIC PAYMENT,,100\n');
    expect(p).toEqual({ ok: true, items: [{ date: '2026-11-02', desc: 'KROGER', amount: 45.1 }, { date: '2026-11-03', desc: 'REFUND', amount: -5 }] });
    // purchases already positive (more positives than negatives): kept as they are
    const q = parseCardCSV('Date,Description,Amount\n11/2/26,KROGER,45.10\n11/3/26,REFUND,(3.00)\n11/4/26,STORE,"$1,003.00"\n');
    expect(q).toEqual({ ok: true, items: [{ date: '2026-11-02', desc: 'KROGER', amount: 45.1 }, { date: '2026-11-03', desc: 'REFUND', amount: -3 }, { date: '2026-11-04', desc: 'STORE', amount: 1003 }] });
  });
  it('explains files it can’t read', () => {
    expect(parseCardCSV('a,b\n1,2')).toEqual({ ok: false, error: 'Couldn’t find Date and Amount columns in that file.' });
    expect(parseCardCSV('Date,Description,Amount,Type\n11/1/26,Payment Thank You,50,Payment')).toEqual({ ok: false, error: 'No purchases found in that file.' });
  });
});

describe('rule 13: old backups', () => {
  it('adds balanceApplied amounts back and clears the marker', () => {
    const m = sampleMonth();
    expect(acct(m, 'chk1').balance).toBe(580);
    expect(bill(m, 'b-net').balanceApplied).toBeNull();
  });
  it('wraps very old single-month files and rejects junk', () => {
    const st = readBackup({ month: '2026-09', accounts: [{ id: 'a', name: 'A', balance: 1 }], bills: [] });
    expect(st.current).toBe('2026-09');
    expect(st.months['2026-09'].budget.cats).toHaveLength(14);
    expect(() => readBackup({ hello: 1 })).toThrow(/doesn’t look like/);
    expect(() => readBackup({ current: 'x', months: { x: {} } })).toThrow(/isn’t a month/);
  });
  it('exports back to the same shape it read', () => {
    const st = sampleState();
    st.months[K].meta = { version: 3 };
    st.months[K].accounts[0].version = 4;
    const out = toBackup(st);
    expect(out.months[K].meta).toBeUndefined();
    expect(out.months[K].accounts[0]).toEqual({ id: 'chk1', name: 'Sample Checking', balance: 580, deposit: 1500, color: '#5c8a72' });
    expect(readBackup(JSON.parse(JSON.stringify(out)))).toEqual(readBackup(JSON.parse(JSON.stringify(out))));
  });
});

describe('ops: validation', () => {
  it('rejects bad ids, unknown rows and duplicate ids', () => {
    const m = emptyMonth();
    expect(() => applyOp(m, K, { type: 'account.add', id: 'bad id!', name: 'x' })).toThrow(/Bad id/);
    expect(() => applyOp(m, K, { type: 'bill.update', id: 'nope', patch: {} })).toThrow(/isn’t in this month/);
    applyOp(m, K, { type: 'account.add', id: 'a1', name: ' Wells ', balance: '$1,234.50', deposit: '-20' });
    expect(m.accounts[0]).toMatchObject({ name: 'Wells', balance: 1234.5, deposit: 20, color: '#5c8a72' });
    expect(() => applyOp(m, K, { type: 'account.add', id: 'a1', name: 'x' })).toThrow(/already used/);
    applyOp(m, K, { type: 'bill.add', id: 'b1', name: 'Rent', amount: '-900', accountId: 'a1', dueDay: '45' });
    expect(m.bills[0]).toMatchObject({ amount: 900, dueDay: null, recurring: true, paid: false });
    applyOp(m, K, { type: 'account.remove', id: 'a1' });
    expect(m.bills[0].accountId).toBeNull();
  });
});

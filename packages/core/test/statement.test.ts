import { describe, expect, it } from 'vitest';
import { acctStats, applyOp, applyStatementBills, cycleClosingIn, planRelabel, statementsFor, type Month } from '../src/index.js';
import { sampleState, seqId } from './helpers.js';

const setup = () => {
  const st = sampleState();
  const nov = st.months['2026-11'];
  applyOp(nov, '2026-11', { type: 'card.update', id: 'card-boa', patch: { closeDay: 12, dueDay: 9 } });
  applyOp(nov, '2026-11', { type: 'card.update', id: 'card-chase', patch: { closeDay: '21', dueDay: '19' } });
  return st;
};
const exp = (m: Month, key: string, id: string, date: string, amount: number, cardId = 'card-chase') =>
  applyOp(m, key, { type: 'expense.add', id, date, desc: 'x' + id, amount, catId: 'cat-other', cardId });

describe('statement cycles', () => {
  it('closing day → the cycle that closes in a month', () => {
    expect(cycleClosingIn('2026-11', 21)).toEqual({ start: '2026-10-22', end: '2026-11-21' });
    expect(cycleClosingIn('2026-11', 12)).toEqual({ start: '2026-10-13', end: '2026-11-12' });
    expect(cycleClosingIn('2026-03', 31)).toEqual({ start: '2026-03-01', end: '2026-03-31' }); // Feb has 28 days
    expect(cycleClosingIn('2026-02', 30)).toEqual({ start: '2026-01-31', end: '2026-02-28' });
  });

  it('a closed statement is the net of the cycle’s charges across both months; an open one is projected', () => {
    const st = setup();
    const nov = st.months['2026-11'];
    const oct: Month = structuredClone(nov); oct.budget.expenses = []; st.months['2026-10'] = oct;
    exp(oct, '2026-10', 'a', '2026-10-21', 999);   // previous cycle
    exp(oct, '2026-10', 'b', '2026-10-22', 100);
    exp(nov, '2026-11', 'c', '2026-11-21', 50);
    exp(nov, '2026-11', 'd', '2026-11-10', -20);    // a return
    exp(nov, '2026-11', 'e', '2026-11-22', 70);    // next cycle
    const closed = statementsFor(st.months, '2026-11', '2026-11-25').find(s => s.cardId === 'card-chase')!;
    expect(closed).toMatchObject({ start: '2026-10-22', end: '2026-11-21', soFar: 130, closed: true, amount: 130, dueDate: '2026-12-19', incomplete: false });
    // on Nov 11, 11 of the cycle's 31 days are left: 130 so far + Chase's $1,071 budget × 11/31
    const open = statementsFor(st.months, '2026-11', '2026-11-10').find(s => s.cardId === 'card-chase')!;
    expect(open).toMatchObject({ closed: false, soFar: 130, amount: 510.03 });
    expect(statementsFor(st.months, '2026-11', '2026-11-25').map(s => s.cardId)).toEqual(['card-boa', 'card-chase']);
  });

  it('sets the linked bill, leaves a paid bill alone, and says when the month before is missing', () => {
    const st = setup();
    const nov = st.months['2026-11'];
    exp(nov, '2026-11', 'c', '2026-11-03', 80);
    expect(statementsFor(st.months, '2026-11', '2026-11-25').find(s => s.cardId === 'card-chase')!.incomplete).toBe(true);
    expect(applyStatementBills(st.months, '2026-11', '2026-11-25')).toEqual(['b-card']);
    expect(nov.bills.find(b => b.id === 'b-card')!.amount).toBe(80);
    applyOp(nov, '2026-11', { type: 'bill.update', id: 'b-card', patch: { paid: true } });
    exp(nov, '2026-11', 'f', '2026-11-04', 5);
    expect(applyStatementBills(st.months, '2026-11', '2026-11-25')).toEqual([]);
    expect(nov.bills.find(b => b.id === 'b-card')!.amount).toBe(80);
  });
});

describe('relabel a month', () => {
  it('November → October: everything kept, November made from October’s ending balances, charges filed by date', () => {
    const st = setup();
    const nov = st.months['2026-11'];
    applyOp(nov, '2026-11', { type: 'bill.update', id: 'b-mort', patch: { paid: true } });
    exp(nov, '2026-11', 'n1', '2026-11-02', 40);
    const before = nov.accounts.map(a => acctStats(nov, a).left);
    const p = planRelabel(nov, '2026-11', '2026-10', st.months, seqId);
    expect(Object.keys(p.write).sort()).toEqual(['2026-10', '2026-11']);
    expect(p.created).toEqual(['2026-11']);
    expect(p.moved).toEqual({ '2026-11': 1 });
    const oct = p.write['2026-10'], newNov = p.write['2026-11'];
    expect(oct.bills.find(b => b.id === 'b-mort')).toMatchObject({ paid: true, loanApplied: { principal: 523.03 } });
    expect(oct.budget.expenses).toEqual([]);
    expect(oct.budget.cards.find(c => c.id === 'card-chase')).toMatchObject({ closeDay: 21, dueDay: 19 });
    expect(newNov.accounts.map(a => a.balance)).toEqual(before);
    expect(newNov.accounts.map(a => a.deposit)).toEqual(nov.accounts.map(a => a.deposit));
    expect(newNov.bills.every(b => !b.paid)).toBe(true);
    expect(newNov.budget.expenses.map(e => e.id)).toEqual(['n1']);
  });

  it('refuses an existing label and charges with nowhere to go', () => {
    const st = setup();
    expect(() => planRelabel(st.months['2026-11'], '2026-11', '2026-11', st.months)).toThrow(/already its label/);
    exp(st.months['2026-11'], '2026-11', 'z', '2026-11-30', 1);
    expect(() => planRelabel(st.months['2026-11'], '2026-11', '2026-08', st.months)).toThrow(/no month to go to/);
  });
});

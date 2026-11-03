// The category memory: past choices for a merchant come before the keyword rules.
import { describe, expect, it } from 'vitest';
import { applyOp, buildNewMonth, guessCat, importCardItems, learnCategories, merchantKey, parseCardCSV, type CategoryMemory } from '../src/index.js';
import { fixture, sampleState, seqId } from './helpers.js';

const K = '2026-11';

describe('merchantKey', () => {
  it.each([
    ['AMAZON MKTPL*5P5JM4NC2', 'AMAZON MKTPL'],
    ['AMAZON MKTPL*629QL7H33', 'AMAZON MKTPL'],
    ['Amazon.com*4H34X89Q3', 'AMAZON.COM'],
    ['KROGER #884', 'KROGER'],
    ['MAPCO EXPRESS #3420', 'MAPCO EXPRESS'],
    ['MAPCO#421978', 'MAPCO'],
    ['SHELL OIL 12826796000', 'SHELL OIL'],
    ['72823 - MILLENNIUM PARK', 'MILLENNIUM PARK'],
    ['TST* JENI\'S SPLENDID ICE', 'TST* JENI\'S SPLENDID ICE'],
    ['SQ *MADTOWN COFFEE  LLC.', 'SQ *MADTOWN COFFEE LLC'],
    ['NAYAX AMUSEMENT 5', 'NAYAX AMUSEMENT 5'],
    ['Sample General Store', 'SAMPLE GENERAL STORE']
  ])('%s → %s', (d, k) => expect(merchantKey(d)).toBe(k));
});

describe('learning and guessing', () => {
  it('the latest choice wins, and CSV guesses teach nothing', () => {
    const mem = learnCategories([
      { desc: 'SAMPLE GENERAL STORE', catId: 'cat-other', catName: 'Other' },
      { desc: 'Sample General Store', catId: 'cat-groceries', catName: 'Groceries' },
      { desc: 'SAMPLE GENERAL STORE', catId: 'cat-amazon', catName: 'Amazon', catChosen: false }
    ]);
    expect(mem['SAMPLE GENERAL STORE']).toEqual({ catId: 'cat-groceries', catName: 'Groceries' });
  });

  it('memory beats the keyword rules; unknown merchants still use them', () => {
    const b = sampleState().months[K].budget;
    const mem: CategoryMemory = { 'SHELL OIL': { catId: 'cat-travel-big-purchases', catName: 'Travel & big purchases' } };
    expect(guessCat('SHELL OIL 000000001', b, mem)?.id).toBe('cat-travel-big-purchases');
    expect(guessCat('SHELL OIL 000000001', b)?.id).toBe('cat-gas');
    expect(guessCat('EXXON 12', b, mem)?.id).toBe('cat-gas');
  });

  it('a category renamed or recreated in another month is found by name', () => {
    const b = sampleState().months[K].budget;
    expect(guessCat('SAMPLE STORE', b, { 'SAMPLE STORE': { catId: 'cat-gone', catName: 'groceries' } })?.id).toBe('cat-groceries');
    expect(guessCat('SAMPLE STORE', b, { 'SAMPLE STORE': { catId: 'cat-gone', catName: 'Deleted' } })?.id).toBe('cat-other');
  });

  it('marks which categories a person chose', () => {
    const m = sampleState().months[K];
    applyOp(m, K, { type: 'expense.add', id: 'e1', date: '2026-11-02', desc: 'x', amount: 1, catId: 'cat-gas', cardId: 'card-boa' });
    expect(m.budget.expenses[0].catChosen).toBe(true);
    applyOp(m, K, { type: 'expense.add', id: 'e2', date: '2026-11-02', desc: 'y', amount: 1, catId: 'cat-gas', cardId: 'card-boa', source: 'csv' });
    expect(m.budget.expenses[1].catChosen).toBe(false);
    applyOp(m, K, { type: 'expense.update', id: 'e2', patch: { amount: 2 } });
    expect(m.budget.expenses[1].catChosen).toBe(false);
    applyOp(m, K, { type: 'expense.update', id: 'e2', patch: { catId: 'cat-other' } });
    expect(m.budget.expenses[1].catChosen).toBe(true);
  });

  it('CSV import files a re-filed merchant the way it was re-filed', () => {
    const st = sampleState();
    st.months['2026-10'] = buildNewMonth(st.months[K], { balances: 'same', cardBills: 'keep', copyOneTime: false }, seqId);
    const p = parseCardCSV(fixture('sample-card-activity.csv'));
    if (!p.ok) throw new Error(p.error);
    importCardItems(st.months, p.items, 'card-chase', st.months[K], seqId);
    const oct = st.months['2026-10'].budget.expenses;
    const store = oct.find(e => e.desc === 'SAMPLE GENERAL STORE')!;
    expect(store).toMatchObject({ catId: 'cat-other', catChosen: false });
    applyOp(st.months['2026-10'], '2026-10', { type: 'expense.update', id: store.id, patch: { catId: 'cat-groceries' } });
    const mem = learnCategories(Object.values(st.months).flatMap(m => m.budget.expenses.map(e => ({ ...e, catName: m.budget.cats.find(c => c.id === e.catId)?.name || '' }))));
    const next = parseCardCSV('Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/20/2026,11/21/2026,SAMPLE GENERAL STORE,Shopping,Sale,-12.00,\n');
    if (!next.ok) throw new Error(next.error);
    importCardItems(st.months, next.items, 'card-chase', st.months[K], seqId, mem);
    expect(st.months[K].budget.expenses.find(e => e.date === '2026-11-20')).toMatchObject({ catId: 'cat-groceries', catChosen: false });
  });
});

import { newlyOverBudget } from '../src/index.js';
describe('newlyOverBudget', () => {
  it('reports a category once, when it crosses its limit', () => {
    const m0 = sampleState().months[K];
    const add = (m: typeof m0, id: string, amount: number) => applyOp(m, K, { type: 'expense.add', id, date: '2026-11-03', desc: 'x', amount, catId: 'cat-dining-out', cardId: 'card-chase' });
    const m1 = structuredClone(m0); add(m1, 'a', 90);
    expect(newlyOverBudget(m0, m1)).toEqual([]);
    const m2 = structuredClone(m1); add(m2, 'b', 22.4);
    expect(newlyOverBudget(m1, m2)).toEqual([{ catId: 'cat-dining-out', name: 'Dining out', spent: 112.4, limit: 100, cardName: 'Chase' }]);
    const m3 = structuredClone(m2); add(m3, 'c', 5);
    expect(newlyOverBudget(m2, m3)).toEqual([]);   // already over: no second alert
    const m4 = structuredClone(m0); add(m4, 'd', 100);
    expect(newlyOverBudget(m0, m4)).toEqual([]);   // exactly at the limit isn't over
  });
});

import { cleanDesc } from '../src/index.js';
describe('BoA’s padded descriptions', () => {
  it('keep the store name, so the same store matches across cities, sync and CSV', () => {
    expect(cleanDesc('KROGER #884              NASHVILLE    TN ')).toBe('KROGER #884');
    expect(cleanDesc('SPROUTS FARMERS MAR      FRANKLIN     TN ')).toBe('SPROUTS FARMERS MAR');
    expect(cleanDesc('Exxon FLASH  MARKET #1')).toBe('Exxon FLASH MARKET #1');   // Chase: two spaces aren't a column gap
    expect(merchantKey('KROGER #514              MADISON      TN ')).toBe(merchantKey('KROGER #884  '));
  });
});

import { emptyMonth } from '../src/index.js';
describe('re-importing after descriptions were tidied', () => {
  it('a line stored with the old spacing still counts as already logged', () => {
    const months = { '2026-10': emptyMonth() };
    months['2026-10'].budget.expenses.push({ id: 'old', date: '2026-10-20', desc: 'SQ *MADTOWN COFFEE  LLC.', amount: 30.93, catId: 'cat-other', cardId: 'card-chase', source: 'csv' });
    const r = importCardItems(months, [{ date: '2026-10-20', desc: 'SQ *MADTOWN COFFEE LLC.', amount: 30.93 }], 'card-chase', undefined, () => 'n');
    expect(r).toMatchObject({ added: 0, dup: 1 });
  });
});

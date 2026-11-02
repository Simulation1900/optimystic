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

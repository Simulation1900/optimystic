import { describe, expect, it } from 'vitest';
import { budgetStats, buildNewMonth, newlyOverBudget, withPending, cardItems, importCardItems, importSynced, isoInZone, parseCardCSV, syncMessage, type SfTransaction } from '../src/index.js';
import { fixture, sampleState, seqId } from './helpers.js';
import { applyOp } from '../src/index.js';

// 2026-10-20 12:00 Chicago = 17:00 UTC
const at = (iso: string, h = 17) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h) / 1000;
const tx = (id: string, date: string, desc: string, amount: string, extra: Partial<SfTransaction> = {}): SfTransaction =>
  ({ id, posted: at(date) + 86400, transacted_at: at(date), description: desc, amount, ...extra });

const twoMonths = () => {
  const st = sampleState();
  st.months['2026-10'] = buildNewMonth(st.months['2026-11'], { balances: 'same', cardBills: 'keep', copyOneTime: false }, seqId);
  return st;
};

describe('card sync', () => {
  it('dates in the household’s time zone', () => {
    expect(isoInZone(Date.UTC(2026, 10, 1, 3) / 1000)).toBe('2026-10-31'); // 3 AM UTC Nov 1 is still Oct 31 in Chicago
  });

  it('skips pending charges and payments; purchases positive, returns negative; transaction date first', () => {
    const r = cardItems([
      tx('a', '2026-10-20', 'KROGER #884', '-133.72'),
      tx('b', '2026-10-21', 'Amazon.com', '38.37'),
      tx('c', '2026-10-22', 'Payment Thank You-Mobile', '1459.55'),
      tx('d', '2026-10-23', 'SHELL OIL 1', '-20.00', { posted: 0, pending: true }),
      { id: 'e', posted: at('2026-10-24'), description: 'NO TRANSACTED DATE', amount: '-5.00' }
    ]);
    expect(r).toEqual({
      pending: 1, payments: 1,
      pendingItems: [{ id: 'd', date: '2026-10-23', desc: 'SHELL OIL 1', amount: 20 }],
      items: [
        { id: 'a', date: '2026-10-20', desc: 'KROGER #884', amount: 133.72 },
        { id: 'b', date: '2026-10-21', desc: 'Amazon.com', amount: -38.37 },
        { id: 'e', date: '2026-10-24', desc: 'NO TRANSACTED DATE', amount: 5 }
      ]
    });
  });

  it('adds new charges once, filed by month with the category guessed', () => {
    const st = twoMonths();
    const { items } = cardItems([tx('a', '2026-10-20', 'KROGER #884', '-133.72'), tx('b', '2026-11-02', 'SHELL OIL 9', '-40.00'), tx('z', '2026-08-01', 'OLD', '-1')]);
    const r = importSynced(st.months, items, 'card-chase', st.months['2026-11'], seqId);
    expect(r).toEqual({ added: 2, matched: 0, already: 0, skipped: 0, older: 1, months: ['2026-10', '2026-11'] });
    expect(syncMessage(r)).toBe('Added 2 charges to October 2026, November 2026. 1 older charge from before the planner’s first month left out.');
    expect(st.months['2026-10'].budget.expenses[0]).toMatchObject({ desc: 'KROGER #884', amount: 133.72, catId: 'cat-groceries', source: 'sync', catChosen: false, externalId: 'a' });
    expect(importSynced(st.months, items, 'card-chase', st.months['2026-11'], seqId)).toMatchObject({ added: 0, already: 2, older: 1 });
    // a charge in a month after the first that hasn't been started yet is a real skip
    const later = importSynced(st.months, cardItems([tx('q', '2026-12-02', 'X', '-1')]).items, 'card-chase', st.months['2026-11'], seqId);
    expect(later).toMatchObject({ skipped: 1, older: 0 });
    expect(syncMessage(later)).toBe('No new charges. 1 skipped (no planner month for their date; start that month to bring them in).');
  });

  it('a charge already imported by CSV is matched, not added, even when the bank’s text or date differs a little', () => {
    const st = twoMonths();
    const p = parseCardCSV(fixture('sample-card-activity.csv'));
    if (!p.ok) throw new Error(p.error);
    importCardItems(st.months, p.items, 'card-chase', st.months['2026-11'], seqId);
    const before = budgetStats(st.months['2026-10']).spent;
    const { items } = cardItems([
      tx('s1', '2026-10-31', 'SHELL OIL 000000002', '-41.20'),      // CSV had 10/30 SHELL OIL 000000001
      tx('n1', '2026-10-20', 'NAYAX AMUSEMENT 9', '-6.50'),
      tx('n2', '2026-10-20', 'NAYAX AMUSEMENT 9', '-6.50'),
      tx('n3', '2026-10-20', 'NAYAX AMUSEMENT 9', '-6.50')            // a third real charge the CSV didn't have
    ]);
    const r = importSynced(st.months, items, 'card-chase', st.months['2026-11'], seqId);
    expect(r).toMatchObject({ added: 1, matched: 3 });
    expect(budgetStats(st.months['2026-10']).spent).toBe(before + 6.5);
    expect(st.months['2026-10'].budget.expenses.filter(e => /NAYAX/.test(e.desc)).map(e => e.externalId).sort()).toEqual(['n1', 'n2', 'n3']);
    // a different card's identical charge isn't a match
    expect(importSynced(st.months, cardItems([tx('b1', '2026-10-31', 'SHELL OIL 7', '-41.20')]).items, 'card-boa', st.months['2026-11'], seqId).added).toBe(1);
  });

  it('uses the category memory', () => {
    const st = twoMonths();
    const r = importSynced(st.months, cardItems([tx('a', '2026-11-03', 'SAMPLE GENERAL STORE', '-12.00')]).items, 'card-chase', st.months['2026-11'], seqId,
      { 'SAMPLE GENERAL STORE': { catId: 'cat-groceries', catName: 'Groceries' } });
    expect(r.added).toBe(1);
    expect(st.months['2026-11'].budget.expenses[0].catId).toBe('cat-groceries');
  });
});

describe('pending charges count like posted ones where they should', () => {
  it('withPending adds them for this month only; crossing a limit by pending alerts, posting it doesn’t re-alert', () => {
    const st = sampleState();
    const m = st.months['2026-11'];
    applyOp(m, '2026-11', { type: 'expense.add', id: 'e1', date: '2026-11-02', desc: 'TST* GRILL', amount: 90, catId: 'cat-dining-out', cardId: 'card-chase' });
    const pend = [{ id: 'p1', cardId: 'card-chase', date: '2026-11-03', desc: 'TST* GRILL', amount: 20, catId: 'cat-dining-out' },
                  { id: 'p2', cardId: 'card-chase', date: '2026-10-30', desc: 'old', amount: 5, catId: 'cat-dining-out' }];
    const shown = withPending(m, pend, '2026-11');
    expect(budgetStats(shown).byCat['cat-dining-out']).toBe(110);
    expect(budgetStats(m).byCat['cat-dining-out']).toBe(90);  // the month itself is untouched
    expect(newlyOverBudget(withPending(m, [], '2026-11'), shown).map(o => o.name)).toEqual(['Dining out']);
    // the pending charge posts: same total, no second alert
    const posted = structuredClone(m);
    applyOp(posted, '2026-11', { type: 'expense.add', id: 'e2', date: '2026-11-03', desc: 'TST* GRILL', amount: 20, catId: 'cat-dining-out', cardId: 'card-chase' });
    expect(newlyOverBudget(shown, withPending(posted, [], '2026-11'))).toEqual([]);
  });
});

import { unsettledPending } from '../src/index.js';
describe('pending charges that never seem to post', () => {
  it('a charge still flagged pending 3+ days after its posting date counts as posted', () => {
    const now = at('2026-11-10');
    const r = cardItems([
      tx('b1', '2026-11-01', 'KROGER #12', '-40.00', { pending: true, posted: at('2026-11-02') }),   // 8 days after posting: posted
      tx('b2', '2026-11-08', 'SHELL OIL 3', '-20.00', { pending: true, posted: at('2026-11-09') }),   // 1 day: still pending
      tx('b3', '2026-11-09', 'TARGET 7', '-15.00', { pending: true, posted: 0 })
    ], undefined, now);
    expect(r.items.map(i => i.id)).toEqual(['b1']);
    expect(r.pendingItems.map(i => i.id)).toEqual(['b2', 'b3']);
  });

  it('a pending entry left in the feed after its posted twin arrived is dropped, once per posted charge', () => {
    const pending = [
      { id: 'p1', date: '2026-11-03', desc: 'KROGER #12', amount: 40 },
      { id: 'p2', date: '2026-11-03', desc: 'KROGER #12', amount: 40 },   // a second real charge
      { id: 'p3', date: '2026-11-03', desc: 'SHELL', amount: 25 }
    ];
    const posted = [{ date: '2026-11-04', desc: 'KROGER #12', amount: 40 }, { date: '2026-10-20', desc: 'SHELL', amount: 25 }];
    expect(unsettledPending(pending, posted).map(p => p.id)).toEqual(['p2', 'p3']);
  });
});

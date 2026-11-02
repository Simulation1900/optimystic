import { describe, expect, it } from 'vitest';
import { budgetStats, buildNewMonth, cardItems, importCardItems, importSynced, isoInZone, parseCardCSV, syncMessage, type SfTransaction } from '../src/index.js';
import { fixture, sampleState, seqId } from './helpers.js';

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
    expect(r).toEqual({ added: 2, matched: 0, already: 0, skipped: 1, months: ['2026-10', '2026-11'] });
    expect(syncMessage(r)).toBe('Added 2 charges to October 2026, November 2026. 1 skipped (no planner month for their date).');
    expect(st.months['2026-10'].budget.expenses[0]).toMatchObject({ desc: 'KROGER #884', amount: 133.72, catId: 'cat-groceries', source: 'sync', catChosen: false, externalId: 'a' });
    expect(importSynced(st.months, items, 'card-chase', st.months['2026-11'], seqId)).toMatchObject({ added: 0, already: 2, skipped: 1 });
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

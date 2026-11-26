import { describe, expect, it } from 'vitest';
import { clone, goalProgress, goalValue, monthMetrics, type Goal, type Month } from '../src/index.js';
import { sampleMonth } from './helpers.js';

const goal = (g: Partial<Goal>): Goal => ({ id: 1, kind: 'custom', title: 'x', target: null, ref: null, dueMonth: null, startMonth: '2026-10',
  endMonth: null, status: 'active', notes: '', ...g });

/** Three months of the sample household with the HELOC and a savings account moving. */
function months(): Array<[string, Month]> {
  const base = sampleMonth();
  return ['2026-09', '2026-10', '2026-11'].map((k, i) => {
    const m = clone(base);
    m.heloc.balance = 10000 - i * 1000;
    m.heloc.draws = i === 0 ? [{ id: 'd1', acctId: m.accounts[0].id, amount: 500 }] : [];
    m.accounts[2].balance = 300 + i * 200;
    if (m.loans[0]) m.loans[0].balance = 8000 - i * 400;
    return [k, m] as [string, Month];
  });
}

describe('household goals', () => {
  it('measure HELOC balance and draws, savings, overage and shortfall from each month', () => {
    const ms = months();
    expect(goalValue({ kind: 'heloc_balance', ref: null }, ms[2][1])).toBe(8000);
    expect(goalValue({ kind: 'heloc_draws', ref: null }, ms[0][1])).toBe(500);
    expect(goalValue({ kind: 'savings', ref: ms[0][1].accounts[2].name.toUpperCase() }, ms[1][1])).toBe(500);  // names match ignoring case
    expect(goalValue({ kind: 'savings', ref: 'No such account' }, ms[1][1])).toBeNull();
    expect(goalValue({ kind: 'card_overage', ref: null }, ms[0][1])).toBeGreaterThanOrEqual(0);
    expect(goalValue({ kind: 'shortfall', ref: null }, ms[0][1])).toBe(0);  // the sample month has money left over
    expect(goalValue({ kind: 'custom', ref: null }, ms[0][1])).toBeNull();
    expect(goalValue({ kind: 'heloc_balance', ref: null }, { ...ms[0][1], cardOnly: true })).toBeNull();
  });

  it('carry over from the start month, include the month before as the baseline, and judge the trend', () => {
    const ms = months();
    const p = goalProgress(goal({ kind: 'heloc_balance', target: 5000, startMonth: '2026-10' }), ms);
    expect(p.series.map(s => s.key)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect([p.first, p.latest, p.improvement, p.trend, p.met]).toEqual([10000, 8000, 2000, 'better', false]);
    const s = goalProgress(goal({ kind: 'savings', ref: ms[0][1].accounts[2].name, target: 600, startMonth: '2026-11' }), ms);
    expect([s.first, s.latest, s.improvement, s.met]).toEqual([500, 700, 200, true]);
    const ended = goalProgress(goal({ kind: 'heloc_balance', target: 0, startMonth: '2026-09', endMonth: '2026-10', status: 'done' }), ms);
    expect(ended.series.map(x => x.key)).toEqual(['2026-09', '2026-10']);
    expect(ended.met).toBe(true);
  });

  it('summarise each month for the review', () => {
    const [k, m] = months()[0];
    expect(monthMetrics(k, m)).toMatchObject({ month: '2026-09', heloc_balance: 10000, heloc_drawn: 500, starting_balances: 1000 });
  });
});

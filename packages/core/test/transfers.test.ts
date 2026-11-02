import { describe, expect, it } from 'vitest';
import { acctStats, applyOp, buildNewMonth, monthTotals, readBackup, shortfalls, surplusAccounts, toBackup, type Month } from '../src/index.js';
import { sampleMonth, seqId } from './helpers.js';

const K = '2026-11';
const left = (m: Month, id: string) => acctStats(m, m.accounts.find(a => a.id === id)!).left;

describe('transfers between accounts', () => {
  it('move left-after-bills from one account to another; household left over and balances stay put', () => {
    const m = sampleMonth();
    const before = monthTotals(m).left;
    applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'sav1', amount: '600', note: 'cover the card' });
    expect(left(m, 'chk1')).toBe(721.76);
    expect(left(m, 'sav1')).toBe(0);
    expect(acctStats(m, m.accounts[0])).toMatchObject({ xferOut: 600, xferIn: 0 });
    expect(m.accounts.map(a => a.balance)).toEqual([580, 120, 300]);
    expect(monthTotals(m).left).toBe(before);
    expect(shortfalls(m)).toEqual([]);
  });

  it('done is only a marker; editing and removing put the numbers back', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'sav1', amount: 600 });
    applyOp(m, K, { type: 'transfer.update', id: 't1', patch: { done: true } });
    expect(left(m, 'sav1')).toBe(0);
    applyOp(m, K, { type: 'transfer.update', id: 't1', patch: { amount: 100, toId: 'chk2' } });
    expect(left(m, 'chk2')).toBe(570.37);
    expect(left(m, 'sav1')).toBe(-600);
    applyOp(m, K, { type: 'transfer.remove', id: 't1' });
    expect(left(m, 'chk1')).toBe(1321.76);
    expect(left(m, 'chk2')).toBe(470.37);
  });

  it('refuses the same account twice, a missing account, or no amount', () => {
    const m = sampleMonth();
    expect(() => applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'chk1', amount: 5 })).toThrow(/two different/);
    expect(() => applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'nope', amount: 5 })).toThrow(/isn’t in this month/);
    expect(() => applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'sav1', amount: 0 })).toThrow(/amount/);
    expect(m.transfers).toEqual([]);
  });

  it('removing an account removes its transfers', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'sav1', amount: 50 });
    applyOp(m, K, { type: 'account.remove', id: 'sav1' });
    expect(m.transfers).toEqual([]);
    expect(left(m, 'chk1')).toBe(1321.76);
  });

  it('suggests where a shortfall transfer could come from', () => {
    const m = sampleMonth();
    expect(surplusAccounts(m, 'sav1').map(x => [x.account.id, x.left])).toEqual([['chk1', 1321.76], ['chk2', 470.37]]);
  });

  it('a new month copies monthly transfers (not done) and leaves one-offs; forecast balances include them', () => {
    const m = sampleMonth();
    applyOp(m, K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'sav1', amount: 500, recurring: true });
    applyOp(m, K, { type: 'transfer.add', id: 't2', fromId: 'chk2', toId: 'sav1', amount: 100 });
    applyOp(m, K, { type: 'transfer.update', id: 't1', patch: { done: true } });
    const nm = buildNewMonth(m, { balances: 'forecast', cardBills: 'keep', copyOneTime: false }, seqId);
    expect(nm.transfers).toHaveLength(1);
    expect(nm.transfers[0]).toMatchObject({ fromId: 'chk1', toId: 'sav1', amount: 500, recurring: true, done: false });
    expect(nm.transfers[0].id).not.toBe('t1');
    expect(nm.accounts.map(a => a.balance)).toEqual([821.76, 370.37, 0]);
  });

  it('round-trips through a backup; older backups without transfers read as none', () => {
    const st = { current: K, months: { [K]: sampleMonth() } };
    applyOp(st.months[K], K, { type: 'transfer.add', id: 't1', fromId: 'chk1', toId: 'sav1', amount: 5, note: 'x' });
    expect(readBackup(JSON.parse(JSON.stringify(toBackup(st)))).months[K].transfers).toEqual([{ id: 't1', fromId: 'chk1', toId: 'sav1', amount: 5, note: 'x', recurring: false, done: false }]);
    const old = JSON.parse(JSON.stringify(toBackup(st)));
    delete old.months[K].transfers;
    expect(readBackup(old).months[K].transfers).toEqual([]);
  });
});

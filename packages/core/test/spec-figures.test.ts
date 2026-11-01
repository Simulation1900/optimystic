// The spec's Testing table: numbers already checked against statements and the HTML planner.
import { describe, expect, it } from 'vitest';
import {
  applyLoan, budgetStats, emptyMonth, helocCalc, importCardItems, loanCalc, parseCardCSV, applyOp, readBackup, sumOf,
  type Bill, type Loan, type Month
} from '../src/index.js';
import { privateFile, seqId } from './helpers.js';

const loan = (p: Partial<Loan>): Loan => ({
  id: 'x', kind: 'car', name: 'x', lender: '', balance: 0, rate: 0, payment: 0, escrow: 0, original: 0, open: '', term: 0, vin: '',
  purchasePrice: 0, value: 0, valueAsOf: '2026-11', valueRate: 0, valueEstimated: false, billName: '', customPmt: 0, ...p
});

describe('spec figures', () => {
  it('HELOC interest, Nov 2026, $55,001.82 at 8% → $361.66', () => {
    const m = emptyMonth();
    m.heloc.balance = 55001.82; m.heloc.available = 24998.18;
    expect(helocCalc(m, '2026-11').thisMonth).toBe(361.66);
    // and checking a HELOC bill for that amount puts all of it on interest
    applyOp(m, '2026-11', { type: 'bill.add', id: 'h', name: 'HELOC', amount: 361.66 });
    applyOp(m, '2026-11', { type: 'bill.update', id: 'h', patch: { paid: true } });
    expect(m.bills[0].helocApplied).toEqual({ interest: 361.66, principal: 0 });
  });

  it('Mortgage payment split, $216,054.15 at 2.75% → $495.12 interest · $523.03 principal · $631.48 escrow', () => {
    const l = loan({ id: 'mortgage', kind: 'home', balance: 216054.15, rate: 2.75, payment: 1649.63, escrow: 631.48 });
    const b = { id: 'b', name: 'Mortgage', amount: 1649.63 } as Bill;
    applyLoan(b, l);
    expect(b.loanApplied).toEqual({ loanId: 'mortgage', interest: 495.12, principal: 523.03, escrow: 631.48 });
    expect(l.balance).toBe(215531.12);
  });

  it('Mortgage original loan, Dec 2020, 360 months: $249,400 → $1,018.15 principal and interest', () => {
    const m: Month = { ...emptyMonth(), loans: [loan({ kind: 'home', balance: 215531.12, rate: 2.75, payment: 1649.63, escrow: 631.48, original: 249400, open: '2020-12', term: 360 })] };
    expect(loanCalc(m, m.loans[0], '2026-11').sched?.pmt).toBe(1018.15);
  });

  it('Focus ST contract, $17,332.73 at 4.68%, 72 months → $276.58 a month', () => {
    const m: Month = { ...emptyMonth(), loans: [loan({ balance: 3661.07, rate: 4.68, payment: 276.58, original: 17332.73, open: '2021-11', term: 72 })] };
    expect(loanCalc(m, m.loans[0], '2026-11').sched?.pmt).toBe(276.58);
  });

  it('HELOC 10-year repayment payment at $49,486.50 → $600.41', () => {
    const m = emptyMonth();
    m.heloc.balance = 49486.5;
    expect(helocCalc(m, '2026-11').repayPmt).toBe(600.41);
  });

  it('Two identical charges on one day are both kept', () => {
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n'
      + '10/10/2026,10/12/2026,NAYAX AMUSEMENT 5,Automotive,Sale,-8.68,\n10/10/2026,10/12/2026,NAYAX AMUSEMENT 5,Automotive,Sale,-8.68,\n';
    const p = parseCardCSV(csv);
    if (!p.ok) throw new Error(p.error);
    const months = { '2026-10': emptyMonth() };
    expect(importCardItems(months, p.items, 'card-chase', undefined, seqId).added).toBe(2);
    expect(months['2026-10'].budget.expenses.filter(e => e.amount === 8.68)).toHaveLength(2);
    // and importing the same file again adds nothing
    expect(importCardItems(months, p.items, 'card-chase', undefined, seqId)).toMatchObject({ added: 0, dup: 2 });
  });
});

// The Chase figures come from the household's real downloads, which aren't committed.
const oct = privateFile(/Activity_20261031\.csv$/);
const sep = privateFile(/Activity_20261101\.csv$/);
describe.skipIf(!oct || !sep)('spec figures from the real Chase downloads', () => {
  const parse = (t: string) => { const p = parseCardCSV(t); if (!p.ok) throw new Error(p.error); return p.items; };

  it('Oct 31 download (9/22–10/21 statement cycle), net of returns → $3,079.38', () => {
    expect(sumOf(parse(oct!).map(i => i.amount))).toBe(3079.38);
  });

  it('Statement purchases before returns: October $3,155.02, September $1,588.51', () => {
    expect(sumOf(parse(oct!).filter(i => i.amount > 0).map(i => i.amount))).toBe(3155.02);
    expect(sumOf(parse(sep!).filter(i => i.amount > 0).map(i => i.amount))).toBe(1588.51);
  });

  it('Filed by calendar month: Aug $488.03, Sep $1,290.81, Oct $2,835.73; nothing lost or doubled', () => {
    const months = { '2026-08': emptyMonth(), '2026-09': emptyMonth(), '2026-10': emptyMonth() };
    const a = importCardItems(months, parse(oct!), 'card-chase', undefined, seqId);
    const b = importCardItems(months, parse(sep!), 'card-chase', undefined, seqId);
    expect(a.added + b.added).toBe(158);
    expect(budgetStats(months['2026-08']).spent).toBe(488.03);
    expect(budgetStats(months['2026-09']).spent).toBe(1290.81);
    expect(budgetStats(months['2026-10']).spent).toBe(2835.73);
    expect(months['2026-10'].budget.expenses.filter(e => /NAYAX/.test(e.desc))).toHaveLength(2);
    expect(importCardItems(months, parse(oct!), 'card-chase', undefined, seqId)).toMatchObject({ added: 0, dup: 93 });
  });
});

const realBackup = privateFile(/backup-2026-11-01.*\.json$/);
describe.skipIf(!realBackup)('the real Nov 1 backup', () => {
  it('reads and keeps its applied loan payments', () => {
    const st = readBackup(realBackup!);
    const m = st.months['2026-11'];
    expect(m.bills.find(b => b.name === 'Mortgage')?.loanApplied).toMatchObject({ interest: 495.12, principal: 523.03, escrow: 631.48 });
    expect(m.loans.find(l => l.id === 'mortgage')?.balance).toBe(215531.12);
  });
});

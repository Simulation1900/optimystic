import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readBackup, toBackup } from '@optimystic/core';
import { Client, fixture, start, stop, withSample, type Ctx } from './setup.js';

let ctx: Ctx, c: Client;
beforeEach(async () => {
  if (ctx) await stop(ctx);
  ctx = await start();
  c = await withSample(ctx);
});
afterAll(async () => { await stop(ctx); });

const K = '/api/months/2026-11';

describe('import and export', () => {
  it('import reports matching check figures from the file and the database', async () => {
    const r = await c.post('/api/import', JSON.parse(fixture('sample-backup.json')));
    const j = r.json();
    expect(j.matches).toBe(true);
    expect(j.mismatches).toEqual([]);
    expect(j.fromDb[0]).toMatchObject({
      key: '2026-11', householdLeft: 1176.14, helocBalance: 55001.82, budgetLimit: 2741,
      accounts: [{ id: 'chk1', left: 1321.76 }, { id: 'chk2', left: 470.37 }, { id: 'sav1', left: -600 }]
    });
  });

  it('export gives back the same planner, in the HTML planner’s format', async () => {
    const r = await c.get('/api/export');
    expect(r.headers['content-disposition']).toMatch(/bill-planner-backup-\d{4}-\d{2}-\d{2}\.json/);
    const out = JSON.parse(r.body);
    expect(out).toEqual(toBackup(readBackup(fixture('sample-backup.json'))));
    expect(JSON.stringify(out)).not.toMatch(/"version"|"updatedAt"/);
  });

  it('rejects files that aren’t backups', async () => {
    const r = await c.post('/api/import', { nope: true });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/doesn’t look like/);
  });
});

describe('a month', () => {
  it('comes with its totals', async () => {
    const j = (await c.get(K)).json();
    expect(j.months).toEqual(['2026-11']);
    expect(j.totals).toMatchObject({ left: 1176.14, cash: 1000, unassignedCount: 1 });
    expect(j.heloc.thisMonth).toBe(361.66);
    expect(j.month.accounts[0]).toMatchObject({ id: 'chk1', balance: 580, version: 1, updatedBy: 'Nate' });
  });

  it('marking the mortgage paid applies it to the loan, and unmarking puts it back', async () => {
    let j = (await c.patch(`${K}/bills/b-mort`, { paid: true, version: 1 })).json();
    expect(j.month.loans.find((l: any) => l.id === 'mortgage').balance).toBe(215531.12);
    expect(j.month.bills.find((b: any) => b.id === 'b-mort')).toMatchObject({ paid: true, version: 2, loanApplied: { interest: 495.12, principal: 523.03, escrow: 631.48 } });
    expect(j.totals.left).toBe(1176.14); // paid is a marker: left over doesn't move
    j = (await c.patch(`${K}/bills/b-mort`, { paid: false })).json();
    expect(j.month.loans.find((l: any) => l.id === 'mortgage').balance).toBe(216054.15);
    const audit = (await c.get('/api/audit')).json().entries;
    expect(audit.slice(0, 4).map((a: any) => `${a.table_name}:${a.action}`)).toEqual(expect.arrayContaining(['bills:update', 'loans:update']));
    expect(audit[0].user).toBe('Nate');
  });

  it('two phones editing the same bill: the second gets 409 and the latest month', async () => {
    const ok = await c.patch(`${K}/bills/b-tv`, { amount: 17.99, version: 1 });
    expect(ok.statusCode).toBe(200);
    const stale = await c.patch(`${K}/bills/b-tv`, { amount: 12.99, version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().latest.month.bills.find((b: any) => b.id === 'b-tv')).toMatchObject({ amount: 17.99, version: 2 });
  });

  it('edits to different rows at the same time all land', async () => {
    const ids = ['b-mort', 'b-heloc', 'b-car', 'b-net', 'b-card', 'b-tv', 'b-gift'];
    const rs = await Promise.all(ids.map((id, i) => c.patch(`${K}/bills/${id}`, { amount: 100 + i, version: 1 })));
    expect(rs.map(r => r.statusCode)).toEqual(ids.map(() => 200));
    const j = (await c.get(K)).json();
    ids.forEach((id, i) => expect(j.month.bills.find((b: any) => b.id === id).amount).toBe(100 + i));
  });

  it('accounts and bills: add, move, remove', async () => {
    let r = await c.post(`${K}/accounts`, { id: 'new1', name: 'Credit Union', balance: '250.50', deposit: 100 });
    expect(r.statusCode).toBe(201);
    expect(r.json().month.accounts.find((a: any) => a.id === 'new1')).toMatchObject({ balance: 250.5, deposit: 100, color: '#4f80a8' });
    r = await c.post(`${K}/bills`, { id: 'nb1', name: 'Gym', amount: 30, accountId: 'new1', dueDay: 5 });
    expect(r.json().totals.accounts.new1.left).toBe(320.5);
    r = await c.patch(`${K}/bills/nb1`, { accountId: null });
    expect(r.json().totals.unassignedCount).toBe(2);
    r = await c.del(`${K}/accounts/new1`);
    expect(r.json().month.accounts.map((a: any) => a.id)).toEqual(['chk1', 'chk2', 'sav1']);
    r = await c.del(`${K}/bills/nb1`);
    expect(r.json().month.bills.some((b: any) => b.id === 'nb1')).toBe(false);
    expect((await c.patch(`${K}/bills/nope`, { amount: 1 })).statusCode).toBe(404);
  });
});

describe('HELOC', () => {
  it('draws, covers shortfalls and undoes', async () => {
    let j = (await c.post(`${K}/heloc/cover-shortfalls`, {})).json();
    expect(j.totals.accounts.sav1.left).toBe(0);
    expect(j.month.heloc).toMatchObject({ balance: 55601.82, available: 24398.18 });
    const draw = j.month.heloc.draws[0];
    expect(draw).toMatchObject({ acctId: 'sav1', amount: 600 });
    j = (await c.del(`${K}/heloc/draws/${draw.id}`)).json();
    expect(j.month.heloc).toMatchObject({ balance: 55001.82, draws: [] });
    const big = await c.post(`${K}/heloc/draws`, { acctId: 'chk1', amount: 999999 });
    expect(big.statusCode).toBe(422);
    j = (await c.post(`${K}/heloc/draws`, { acctId: 'chk1', amount: 50 })).json();
    expect(j.month.accounts.find((a: any) => a.id === 'chk1').balance).toBe(630);
  });

  it('rate what-ifs and the HELOC bill', async () => {
    let j = (await c.patch(`${K}/heloc`, { rate: 7.5 })).json();
    expect(j.heloc.thisMonth).toBe(339.05);
    j = (await c.post(`${K}/heloc/bill`, { amount: j.heloc.thisMonth })).json();
    expect(j.month.bills.find((b: any) => b.name === 'HELOC').amount).toBe(339.05);
  });
});

describe('new month', () => {
  it('copies with forecast balances and projected card bills; refuses to overwrite without asking', async () => {
    await c.post(`${K}/budget/expenses`, { id: 'e1', date: '2026-11-05', desc: 'Kroger', amount: 120, catId: 'cat-groceries', cardId: 'card-boa' });
    const r = await c.post('/api/months', { key: '2026-12', from: '2026-11', balances: 'forecast', cardBills: 'projected', copyOneTime: false });
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.months).toEqual(['2026-11', '2026-12']);
    expect(j.month.accounts.map((a: any) => a.balance)).toEqual([1321.76, 470.37, -600]);
    expect(j.month.bills.find((b: any) => b.name === 'BoA Credit Bill').amount).toBe(1670);
    expect(j.month.bills.find((b: any) => b.name === 'Chase Credit Bill').amount).toBe(1071);
    expect(j.month.bills.some((b: any) => b.name === 'Birthday gift')).toBe(false);
    expect(j.month.budget.expenses).toEqual([]);
    expect((await c.post('/api/months', { key: '2026-12', from: '2026-11' })).statusCode).toBe(409);
    expect((await c.post('/api/months', { key: '2026-12', from: '2026-11', balances: 'zero', replace: true })).json().month.accounts[0].balance).toBe(0);
    expect((await c.del('/api/months/2026-12')).json().months).toEqual(['2026-11']);
    expect((await c.del(K)).statusCode).toBe(400);
  });
});

describe('card budget', () => {
  it('expenses, categories and cards', async () => {
    let j = (await c.post(`${K}/budget/expenses`, { id: 'e1', date: '2026-11-05', desc: 'Kroger', amount: 120, catId: 'cat-groceries', cardId: 'card-boa' })).json();
    expect(j.budget.spent).toBe(120);
    j = (await c.patch(`${K}/budget/expenses/e1`, { amount: -20 })).json();
    expect(j.budget.byCat['cat-groceries']).toBe(-20);
    expect((await c.post(`${K}/budget/expenses`, { date: '2026-10-05', desc: 'x', amount: 1, catId: 'cat-gas', cardId: 'card-boa' })).statusCode).toBe(400);
    j = (await c.patch(`${K}/budget/categories/cat-gas`, { limit: 300 })).json();
    expect(j.budget.limit).toBe(2791);
    j = (await c.patch(`${K}/budget`, { baseline: 5000 })).json();
    expect(j.month.budget.baseline).toBe(5000);
    j = (await c.post(`${K}/budget/cards`, { id: 'card-amex', name: 'Amex' })).json();
    expect(j.month.budget.cards).toHaveLength(3);
    j = (await c.del(`${K}/budget/cards/card-amex`)).json();
    expect(j.month.budget.cards).toHaveLength(2);
    j = (await c.del(`${K}/budget/expenses/e1`)).json();
    expect(j.budget.spent).toBe(0);
  });

  it('CSV import files lines by month, reports what it skipped, and never doubles', async () => {
    await c.post('/api/months', { key: '2026-10', from: '2026-11', balances: 'same', cardBills: 'keep' });
    const csv = fixture('sample-card-activity.csv');
    let r = await c.post('/api/budget/import', { card: 'card-chase', csv, month: '2026-11' });
    // the September line is before the first month (October): it gets a card-only month
    expect(r.json()).toMatchObject({ added: 11, dup: 0, skipped: 0, created: ['2026-09'], months: ['2026-09', '2026-10', '2026-11'] });
    r = await c.post('/api/budget/import', { card: 'card-chase', csv, month: '2026-11' });
    expect(r.json()).toMatchObject({ added: 0, alreadyLogged: 11, skipped: 0 });
    const oct = (await c.get('/api/months/2026-10')).json();
    expect(oct.budget.spent).toBe(96.54);
    expect(oct.month.budget.expenses.filter((e: any) => /NAYAX/.test(e.desc))).toHaveLength(2);
    const fp = await ctx.db.query("SELECT count(*)::int AS n FROM card_expenses WHERE import_fingerprint IS NOT NULL AND source = 'csv'");
    expect(fp.rows[0].n).toBe(11);
    expect((await c.post('/api/budget/import', { card: 'card-chase', csv: 'hello' })).statusCode).toBe(422);
  });
});

describe('generic ops endpoint', () => {
  it('applies a list of ops in one go, or none of them', async () => {
    let r = await c.post(`${K}/ops`, { ops: [
      { type: 'bill.update', id: 'b-tv', patch: { accountId: 'chk1' } },
      { type: 'bill.update', id: 'b-tv', patch: { paid: true } }
    ] });
    expect(r.json().month.bills.find((b: any) => b.id === 'b-tv')).toMatchObject({ accountId: 'chk1', paid: true });
    r = await c.post(`${K}/ops`, { ops: [
      { type: 'bill.update', id: 'b-tv', patch: { amount: 1 } },
      { type: 'bill.update', id: 'nope', patch: { amount: 2 } }
    ] });
    expect(r.statusCode).toBe(404);
    expect((await c.get(K)).json().month.bills.find((b: any) => b.id === 'b-tv').amount).toBe(15.99);
  });
});

describe('category memory', () => {
  it('learns from re-filed expenses across months and uses it for the next import', async () => {
    await c.post('/api/months', { key: '2026-10', from: '2026-11', balances: 'same', cardBills: 'keep' });
    await c.post('/api/budget/import', { card: 'card-chase', csv: fixture('sample-card-activity.csv'), month: '2026-11' });
    let oct = (await c.get('/api/months/2026-10')).json();
    expect(oct.catMemory).toEqual({});
    const store = oct.month.budget.expenses.find((e: any) => e.desc === 'SAMPLE GENERAL STORE');
    expect(store).toMatchObject({ catId: 'cat-other', catChosen: false });
    oct = (await c.patch(`/api/months/2026-10/budget/expenses/${store.id}`, { catId: 'cat-groceries' })).json();
    expect(oct.catMemory).toEqual({ 'SAMPLE GENERAL STORE': { catId: 'cat-groceries', catName: 'Groceries' } });
    // the November month sees October's choice too
    expect((await c.get(K)).json().catMemory['SAMPLE GENERAL STORE'].catId).toBe('cat-groceries');
    const r = await c.post('/api/budget/import', { card: 'card-chase', month: '2026-11',
      csv: 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/20/2026,11/21/2026,SAMPLE GENERAL STORE,Shopping,Sale,-12.00,\n' });
    expect(r.json().added).toBe(1);
    const nov = (await c.get(K)).json();
    expect(nov.month.budget.expenses.find((e: any) => e.date === '2026-11-20').catId).toBe('cat-groceries');
  });
});

describe('backups from the HTML planner with card expenses', () => {
  it('import (no source field), keep their categories, and teach the category memory', async () => {
    const b = JSON.parse(fixture('sample-backup.json'));
    b.months['2026-11'].budget = {
      baseline: 4537,
      cards: [{ id: 'card-chase', name: 'Chase', billName: 'Chase Credit Bill', color: '#4f80a8' }],
      cats: [{ id: 'cat-groceries', name: 'Groceries', limit: 100, cardId: 'card-chase' }, { id: 'cat-other', name: 'Other', limit: 50, cardId: 'card-chase' }],
      expenses: [{ id: 'x1', date: '2026-11-03', desc: 'SAMPLE STORE #4', amount: 9, catId: 'cat-groceries', cardId: 'card-chase' }]
    };
    const r = await c.post('/api/import', b);
    expect(r.statusCode).toBe(200);
    expect(r.json().matches).toBe(true);
    const j = (await c.get(K)).json();
    expect(j.month.budget.expenses[0]).toMatchObject({ desc: 'SAMPLE STORE #4', catId: 'cat-groceries', source: 'manual', catChosen: true });
    expect(j.catMemory['SAMPLE STORE']).toEqual({ catId: 'cat-groceries', catName: 'Groceries' });
  });
});

describe('transfers', () => {
  it('add, mark done, edit and remove through the API, with the totals following', async () => {
    let r = await c.post(`${K}/transfers`, { id: 'tr1', fromId: 'chk1', toId: 'sav1', amount: 600, note: 'card bill', recurring: true });
    expect(r.statusCode).toBe(201);
    let j = r.json();
    expect(j.totals.accounts.sav1.left).toBe(0);
    expect(j.totals.accounts.chk1).toMatchObject({ xferOut: 600, left: 721.76 });
    expect(j.totals.left).toBe(1176.14);
    expect(j.month.transfers[0]).toMatchObject({ id: 'tr1', amount: 600, recurring: true, done: false, version: 1, updatedBy: 'Nate' });
    j = (await c.patch(`${K}/transfers/tr1`, { done: true, version: 1 })).json();
    expect(j.month.transfers[0]).toMatchObject({ done: true, version: 2 });
    expect((await c.patch(`${K}/transfers/tr1`, { amount: 5, version: 1 })).statusCode).toBe(409);
    expect((await c.post(`${K}/transfers`, { fromId: 'chk1', toId: 'chk1', amount: 5 })).statusCode).toBe(400);
    // carried into the next month, not done
    const nm = (await c.post('/api/months', { key: '2026-12', from: '2026-11', balances: 'same', cardBills: 'keep' })).json();
    expect(nm.month.transfers).toEqual([expect.objectContaining({ fromId: 'chk1', toId: 'sav1', amount: 600, done: false })]);
    // in the export, and gone after removal
    expect(JSON.parse((await c.get('/api/export')).body).months['2026-11'].transfers).toHaveLength(1);
    j = (await c.del(`${K}/transfers/tr1`)).json();
    expect(j.month.transfers).toEqual([]);
    expect(j.totals.accounts.sav1.left).toBe(-600);
  });
});

describe('card bills that follow their statements', () => {
  it('set the linked bill from the statement closing this month, across both months, and stop once paid', async () => {
    // October holds the start of each cycle
    await c.post('/api/months', { key: '2026-10', from: '2026-11', balances: 'same', cardBills: 'keep' });
    await c.post('/api/months/2026-10/budget/expenses', { id: 'o1', date: '2026-10-25', desc: 'Oct charge', amount: 100, catId: 'cat-other', cardId: 'card-chase' });
    await c.post('/api/months/2026-10/budget/expenses', { id: 'o0', date: '2026-10-20', desc: 'last cycle', amount: 999, catId: 'cat-other', cardId: 'card-chase' });
    // turning on Chase's closing day (21st) makes November's Chase bill follow the Oct 22 – Nov 21 statement
    let j = (await c.patch(`${K}/budget/cards/card-chase`, { closeDay: 21, dueDay: 19 })).json();
    const st = j.statements.find((s: any) => s.cardId === 'card-chase');
    expect(st).toMatchObject({ start: '2026-10-22', end: '2026-11-21', soFar: 100, dueDate: '2026-12-19', billName: 'Chase Credit Bill' });
    expect(j.month.bills.find((b: any) => b.name === 'Chase Credit Bill').amount).toBe(st.amount);
    // a November charge in the cycle moves the bill
    j = (await c.post(`${K}/budget/expenses`, { id: 'n1', date: '2026-11-05', desc: 'Nov charge', amount: 50, catId: 'cat-other', cardId: 'card-chase' })).json();
    const st2 = j.statements.find((s: any) => s.cardId === 'card-chase');
    expect(st2.soFar).toBe(150);
    expect(j.month.bills.find((b: any) => b.name === 'Chase Credit Bill').amount).toBe(st2.amount);
    // an October edit (the month before) also updates November's bill
    await c.patch('/api/months/2026-10/budget/expenses/o1', { amount: 200 });
    j = (await c.get(K)).json();
    expect(j.statements.find((s: any) => s.cardId === 'card-chase').soFar).toBe(250);
    expect(j.month.bills.find((b: any) => b.name === 'Chase Credit Bill').amount).toBe(j.statements.find((s: any) => s.cardId === 'card-chase').amount);
    // once paid, it stays as paid
    const bill = j.month.bills.find((b: any) => b.name === 'Chase Credit Bill');
    await c.patch(`${K}/bills/${bill.id}`, { paid: true });
    j = (await c.post(`${K}/budget/expenses`, { id: 'n2', date: '2026-11-06', desc: 'more', amount: 10, catId: 'cat-other', cardId: 'card-chase' })).json();
    expect(j.month.bills.find((b: any) => b.name === 'Chase Credit Bill').amount).toBe(bill.amount);
    // cards without a closing day keep the old behaviour
    expect(j.statements.map((s: any) => s.cardId)).toEqual(['card-chase']);
  });
});

describe('card-only months for older card charges', () => {
  it('a CSV with lines before the first month makes card-only months for them', async () => {
    // the planner starts at November 2026; the sample CSV has lines in Sep, Oct and Nov
    const r = (await c.post('/api/budget/import', { card: 'card-chase', csv: fixture('sample-card-activity.csv'), month: '2026-11' })).json();
    expect(r).toMatchObject({ added: 11, skipped: 0, created: ['2026-09', '2026-10'] });
    expect(r.message).toMatch(/Made September 2026, October 2026 for card spending only\.$/);
    const sep = (await c.get('/api/months/2026-09')).json();
    expect(sep.month).toMatchObject({ cardOnly: true, accounts: [], bills: [], loans: [] });
    expect(sep.month.budget.cats).toHaveLength(14);
    expect(sep.budget.spent).toBe(55.55);
    expect(sep.cardOnlyMonths).toEqual(['2026-09', '2026-10']);
    // no bills or accounts in them, and New month won't copy from them
    expect((await c.post('/api/months/2026-09/bills', { name: 'x', amount: 1 })).json().error).toMatch(/only tracks card spending/);
    expect((await c.post('/api/months', { key: '2026-12', from: '2026-10' })).json().error).toMatch(/only tracks card spending/);
    expect((await c.post('/api/months', { key: '2026-12', from: '2026-11' })).statusCode).toBe(201);
    // they export and import back as card-only
    const back = JSON.parse((await c.get('/api/export')).body);
    expect(back.months['2026-09'].cardOnly).toBe(true);
    expect((await c.post('/api/import', back)).json().matches).toBe(true);
    expect((await c.get('/api/months/2026-10')).json().month.cardOnly).toBe(true);
  });
});

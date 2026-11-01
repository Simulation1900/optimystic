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
    expect(r.json()).toMatchObject({ added: 10, dup: 0, skipped: 1, months: ['2026-10', '2026-11'] });
    r = await c.post('/api/budget/import', { card: 'card-chase', csv, month: '2026-11' });
    expect(r.json()).toMatchObject({ added: 0, alreadyLogged: 10, skipped: 1 });
    const oct = (await c.get('/api/months/2026-10')).json();
    expect(oct.budget.spent).toBe(96.54);
    expect(oct.month.budget.expenses.filter((e: any) => /NAYAX/.test(e.desc))).toHaveLength(2);
    const fp = await ctx.db.query("SELECT count(*)::int AS n FROM card_expenses WHERE import_fingerprint IS NOT NULL AND source = 'csv'");
    expect(fp.rows[0].n).toBe(10);
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

// Runs only when PRIVATE_FIXTURES points at the household's real exports (never committed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, owner, start, stop, type Ctx } from './setup.js';

const dir = process.env.PRIVATE_FIXTURES;
const file = (re: RegExp) => { if (!dir || !existsSync(dir)) return null; const f = readdirSync(dir).find(x => re.test(x)); return f ? readFileSync(join(dir, f), 'utf8') : null; };
const backup = file(/backup-2026-11-01.*\.json$/), oct = file(/Activity_20261031\.csv$/), sep = file(/Activity_20261101\.csv$/);

describe.skipIf(!backup || !oct || !sep)('the real Nov 1 backup and Chase downloads', () => {
  let ctx: Ctx, c: Client;
  beforeAll(async () => { ctx = await start(); c = await owner(ctx); });
  afterAll(async () => { await stop(ctx); });

  it('imports with every check figure matching, and exports back unchanged', async () => {
    const r = (await c.post('/api/import', JSON.parse(backup!))).json();
    expect(r.matches).toBe(true);
    expect(r.fromDb[0].householdLeft).toBe(-2976.24);
    const again = (await c.post('/api/import', JSON.parse((await c.get('/api/export')).body))).json();
    expect(again.fromFile).toEqual(r.fromFile);
  });

  it('files the Chase downloads by calendar month', async () => {
    for (const k of ['2026-10', '2026-09', '2026-08']) await c.post('/api/months', { key: k, from: '2026-11', balances: 'same', cardBills: 'keep' });
    const a = (await c.post('/api/budget/import', { card: 'card-chase', csv: oct })).json();
    const b = (await c.post('/api/budget/import', { card: 'card-chase', csv: sep })).json();
    expect(a.added + b.added).toBe(158);
    expect((await c.get('/api/months/2026-08')).json().budget.spent).toBe(488.03);
    expect((await c.get('/api/months/2026-09')).json().budget.spent).toBe(1290.81);
    expect((await c.get('/api/months/2026-10')).json().budget.spent).toBe(2835.73);
  });
});

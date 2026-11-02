// Card sync against a fake SimpleFIN Bridge that speaks the real protocol (claim, Basic auth, /accounts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client, fixture, start, stop, withSample, type Ctx } from './setup.js';

const now = () => Math.floor(Date.now() / 1000);
let server: Server, port = 0, claimed = false, revoked = false;
let txns: Record<string, unknown[]> = {};
let errors: string[] = [];
const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 17) / 1000;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/claim/abc') {
      if (claimed) { res.writeHead(403).end(); return; }
      claimed = true;
      res.end(`http://user1:secret%2Fpw@127.0.0.1:${port}/simplefin`);
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/simplefin/accounts')) {
      const ok = req.headers.authorization === 'Basic ' + Buffer.from('user1:secret/pw').toString('base64');
      if (!ok || revoked) { res.writeHead(403).end(); return; }
      const u = new URL(req.url, 'http://x');
      expect(Number(u.searchParams.get('start-date'))).toBeGreaterThan(now() - 11 * 86400);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ errors, accounts: [
        { id: 'ACT-chase', name: 'Sapphire ...9954', currency: 'USD', balance: '-1234.56', 'balance-date': now(), org: { name: 'Chase' }, transactions: txns['ACT-chase'] || [] },
        { id: 'ACT-boa', name: 'BoA Visa ...1111', currency: 'USD', balance: '-50.00', 'balance-date': now(), org: { name: 'Bank of America' }, transactions: txns['ACT-boa'] || [] },
        { id: 'ACT-check', name: 'Checking', currency: 'USD', balance: '900.00', org: { name: 'Chase' }, transactions: [{ id: 'x', posted: day('2026-11-02'), amount: '-999', description: 'SHOULD NOT APPEAR' }] }
      ] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r(); }));
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const token = () => Buffer.from(`http://127.0.0.1:${port}/claim/abc`).toString('base64');

describe('card sync without SYNC_KEY', () => {
  it('refuses to connect and says what to set', async () => {
    const noKey = await start({ SIMPLEFIN_ALLOW_HTTP: '1' });
    const o = await withSample(noKey);
    expect((await o.get('/api/sync')).json()).toMatchObject({ connected: false, canConnect: false });
    const r = await o.post('/api/sync/connect', { token: 'x' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/SYNC_KEY/);
    await stop(noKey);
  });
});

describe('card sync (SimpleFIN)', () => {
  let ctx: Ctx, c: Client;
  beforeAll(async () => { ctx = await start({ SYNC_KEY: 'k'.repeat(64), SIMPLEFIN_ALLOW_HTTP: '1', SYNC_TIMES: '' }); c = await withSample(ctx); });
  afterAll(async () => { await stop(ctx); });

  it('needs the owner and a real token', async () => {
    await c.post('/api/users', { name: 'M', email: 'm@example.com', password: 'a long member password' });
    const m = new Client(ctx.app);
    await m.post('/api/auth/login', { email: 'm@example.com', password: 'a long member password' });
    expect((await m.post('/api/sync/connect', { token: token() })).statusCode).toBe(403);
    expect((await c.post('/api/sync/connect', { token: 'not a token' })).statusCode).toBe(400);
  });

  it('connects with a setup token, keeps the access URL encrypted, and lists the accounts to link', async () => {
    const r = await c.post('/api/sync/connect', { token: token() });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ connected: true, lastError: 'No card is linked yet. Choose which SimpleFIN account is which card.' });
    expect(s.accounts.map((a: any) => [a.id, a.org, a.cardKey])).toEqual([['ACT-boa', 'Bank of America', null], ['ACT-check', 'Chase', null], ['ACT-chase', 'Chase', null]]);
    const row = (await ctx.db.query('SELECT access_url_enc FROM bank_connections')).rows[0];
    expect(row.access_url_enc).toMatch(/^v1\./);
    expect(row.access_url_enc).not.toContain('secret');
    expect((await c.post('/api/sync/connect', { token: token() })).json().error).toMatch(/already used/);
  });

  it('files card charges (not the checking account), matches CSV lines, skips pending and payments', async () => {
    await c.post('/api/months', { key: '2026-10', from: '2026-11', balances: 'same', cardBills: 'keep' });
    await c.post('/api/budget/import', { card: 'card-chase', csv: fixture('sample-card-activity.csv'), month: '2026-11' });
    const spentBefore = (await c.get('/api/months/2026-11')).json().budget.spent;
    txns = {
      'ACT-chase': [
        { id: 'c1', posted: day('2026-11-05'), transacted_at: day('2026-11-04'), amount: '-82.15', description: 'KROGER #100' },   // already in the CSV
        { id: 'c2', posted: day('2026-11-06'), transacted_at: day('2026-11-05'), amount: '-19.99', description: 'NETFLIX.COM' },   // new
        { id: 'c3', posted: 0, amount: '-7.00', description: 'PENDING CAFE', pending: true },
        { id: 'c4', posted: day('2026-11-06'), amount: '500.00', description: 'Payment Thank You-Mobile' }
      ],
      'ACT-boa': [{ id: 'b1', posted: day('2026-11-07'), transacted_at: day('2026-11-06'), amount: '-45.10', description: 'KROGER #12' }]
    };
    let s = (await c.post('/api/sync/links', { links: { 'ACT-chase': 'card-chase', 'ACT-boa': 'card-boa' } })).json();
    expect(s.accounts.find((a: any) => a.id === 'ACT-check').cardKey).toBeNull();
    s = (await c.post('/api/sync/run')).json();
    expect(s.lastError).toBeNull();
    expect(s.lastResult).toMatchObject({ added: 2, matched: 1, pending: 1 });
    expect(s.lastResult.message).toBe('Added 2 charges to November 2026. 1 already imported by CSV. 1 pending charge will come in once posted.');
    const nov = (await c.get('/api/months/2026-11')).json();
    expect(nov.budget.spent).toBe(Math.round((spentBefore + 19.99 + 45.10) * 100) / 100);
    expect(nov.month.budget.expenses.find((e: any) => e.desc === 'NETFLIX.COM')).toMatchObject({ source: 'sync', cardId: 'card-chase', catId: 'cat-subscriptions', externalId: 'c2' });
    expect(nov.month.budget.expenses.find((e: any) => e.desc === 'KROGER #100')).toMatchObject({ source: 'csv', externalId: 'c1' });
    expect(nov.month.budget.expenses.some((e: any) => /SHOULD NOT APPEAR|PENDING|Payment/.test(e.desc))).toBe(false);
    expect(nov.sync).toMatchObject({ connected: true, lastError: null });
    // the pending charge posts: it comes in once, and nothing else doubles
    (txns['ACT-chase'] as any[])[2] = { id: 'c3', posted: day('2026-11-07'), transacted_at: day('2026-11-06'), amount: '-7.00', description: 'PENDING CAFE' };
    s = (await c.post('/api/sync/run')).json();
    expect(s.lastResult).toMatchObject({ added: 1, already: 3, matched: 0 });
    // and the CSV can be imported again without doubling the synced charge
    expect((await c.post('/api/budget/import', { card: 'card-chase', csv: fixture('sample-card-activity.csv'), month: '2026-11' })).json().added).toBe(0);
  });

  it('shows bank-side problems and a revoked connection without changing anything', async () => {
    errors = ['Chase: please sign in again at simplefin.org.'];
    let s = (await c.post('/api/sync/run')).json();
    expect(s.lastError).toBe('SimpleFIN: Chase: please sign in again at simplefin.org.');
    errors = [];
    revoked = true;
    const r = await c.post('/api/sync/run');
    expect(r.statusCode).toBe(200);
    expect(r.json().lastError).toMatch(/refused the saved connection/);
    expect((await c.get('/api/months/2026-11')).json().sync.lastError).toMatch(/refused/);
    revoked = false;
    s = (await c.post('/api/sync/run')).json();
    expect(s.lastError).toBeNull();
  });

  it('disconnect forgets the access URL', async () => {
    const s = (await c.del('/api/sync')).json();
    expect(s).toMatchObject({ connected: false, accounts: [] });
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM bank_connections')).rows[0].n).toBe(0);
    expect((await c.post('/api/sync/run')).statusCode).toBe(404);
  });
});

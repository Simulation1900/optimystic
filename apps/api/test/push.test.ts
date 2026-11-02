import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setPushTransport } from '../src/push.js';
import { Client, start, stop, withSample, type Ctx } from './setup.js';

const sent: Array<{ endpoint: string; msg: any }> = [];
let gone = new Set<string>();
setPushTransport(async (sub, payload) => {
  if (gone.has(sub.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 });
  sent.push({ endpoint: sub.endpoint, msg: JSON.parse(payload) });
});
const sub = (n: string) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPk' + n.repeat(20), auth: 'au' + n } });

// fake SimpleFIN with one Chase account whose charges we control
let server: Server, port = 0, txns: unknown[] = [], errors: string[] = [];
const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 17) / 1000;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST') { res.end(`http://u:p@127.0.0.1:${port}/sf`); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ errors, accounts: [{ id: 'A1', name: 'Chase', org: { name: 'Chase' }, balance: '0', transactions: txns }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r(); }));
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('notifications', () => {
  let ctx: Ctx, c: Client, m: Client;
  beforeAll(async () => {
    ctx = await start({ SYNC_KEY: 'k'.repeat(40), SIMPLEFIN_ALLOW_HTTP: '1', SYNC_TIMES: '' });
    c = await withSample(ctx);
    await c.post('/api/users', { name: 'Dejuania', email: 'm@example.com', password: 'a long member password' });
    m = new Client(ctx.app);
    await m.post('/api/auth/login', { email: 'm@example.com', password: 'a long member password' });
  });
  afterAll(async () => { await stop(ctx); });

  it('hands out one stable public key and stores subscriptions', async () => {
    const k1 = (await c.get('/api/push/key')).json().publicKey, k2 = (await m.get('/api/push/key')).json().publicKey;
    expect(k1).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(k2).toBe(k1);
    expect((await c.post('/api/push/test')).statusCode).toBe(404);
    expect((await c.post('/api/push/subscribe', { subscription: { endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } } })).statusCode).toBe(400);
    expect((await c.post('/api/push/subscribe', { subscription: sub('owner') })).statusCode).toBe(200);
    expect((await m.post('/api/push/subscribe', { subscription: sub('member') })).statusCode).toBe(200);
    expect((await c.post('/api/push/test')).json()).toEqual({ sent: 1 });
    expect(sent.pop()).toEqual({ endpoint: sub('owner').endpoint, msg: { title: 'Bill Planner', body: 'Notifications are working on this device.', tag: 'test', url: '/' } });
  });

  it('alerts every device once when a synced charge puts a category over its limit', async () => {
    await c.post('/api/sync/connect', { token: Buffer.from(`http://127.0.0.1:${port}/claim`).toString('base64') });
    await c.post('/api/sync/links', { links: { A1: 'card-chase' } });
    sent.length = 0;
    txns = [{ id: 't1', posted: day('2026-11-04'), transacted_at: day('2026-11-03'), amount: '-90.00', description: 'TST* SAMPLE GRILL' }];
    await c.post('/api/sync/run');
    expect(sent).toEqual([]); // $90 of $100: not over yet
    txns.push({ id: 't2', posted: day('2026-11-05'), transacted_at: day('2026-11-04'), amount: '-22.40', description: 'TST* SAMPLE GRILL' });
    await c.post('/api/sync/run');
    expect(sent.map(s => s.endpoint).sort()).toEqual([sub('member').endpoint, sub('owner').endpoint]);
    expect(sent[0].msg).toEqual({ title: 'Dining out is over budget', body: '$112.40 of $100.00 this month (Chase).', tag: 'over-cat-dining-out', url: '/?tab=budget' });
    sent.length = 0;
    txns.push({ id: 't3', posted: day('2026-11-06'), transacted_at: day('2026-11-05'), amount: '-5.00', description: 'TST* SAMPLE GRILL' });
    await c.post('/api/sync/run');
    expect(sent).toEqual([]); // already over: no repeat
  });

  it('a pending charge that crosses a limit alerts; when it posts, no second alert', async () => {
    sent.length = 0;
    txns = [{ id: 'g1', posted: day('2026-11-04'), transacted_at: day('2026-11-03'), amount: '-30.00', description: 'WALGREENS #1' },
            { id: 'g2', posted: 0, pending: true, transacted_at: day('2026-11-05'), amount: '-60.00', description: 'WALGREENS #2' }];
    await c.post('/api/sync/run');
    expect(sent.map(s => s.msg.title)).toEqual(['Health & pharmacy is over budget', 'Health & pharmacy is over budget']); // both devices
    expect(sent[0].msg.body).toBe('$90.00 of $85.00 this month (Chase).');
    sent.length = 0;
    txns[1] = { id: 'g2-posted', posted: day('2026-11-06'), transacted_at: day('2026-11-05'), amount: '-60.00', description: 'WALGREENS #2' };
    await c.post('/api/sync/run');
    expect(sent).toEqual([]);
  });

  it('tells only the owner when card sync starts having a problem, once', async () => {
    sent.length = 0;
    errors = ['Chase: please sign in again.'];
    await c.post('/api/sync/run');
    await c.post('/api/sync/run');
    expect(sent).toEqual([{ endpoint: sub('owner').endpoint, msg: { title: 'Card sync needs attention', body: 'SimpleFIN: Chase: please sign in again.', tag: 'sync-problem', url: '/?tab=settings' } }]);
    errors = [];
  });

  it('drops devices the push service says are gone, and lets a device unsubscribe', async () => {
    gone = new Set([sub('member').endpoint]);
    await m.post('/api/push/test').catch(() => {});
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(1);
    await c.post('/api/push/unsubscribe', { endpoint: sub('owner').endpoint });
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(0);
  });
});

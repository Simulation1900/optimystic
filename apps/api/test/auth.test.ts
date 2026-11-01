import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, OWNER, owner, start, stop, PUBLIC_URL, type Ctx } from './setup.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await start({ LOGIN_LIMIT: '9' }); });
afterAll(async () => { await stop(ctx); });

describe('two logins, one household', () => {
  it('health check answers without signing in', async () => {
    const r = await new Client(ctx.app).get('/api/health');
    expect(r.json()).toEqual({ ok: true });
  });

  it('first run asks for the owner, then never again', async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get('/api/auth/state')).json()).toEqual({ needsSetup: true, user: null });
    expect((await anon.post('/api/auth/setup', { ...OWNER, password: 'short' })).statusCode).toBe(400);
    const c = await owner(ctx);
    expect((await c.get('/api/auth/state')).json()).toMatchObject({ needsSetup: false, user: { name: 'Nate', role: 'owner' } });
    const again = await new Client(ctx.app).post('/api/auth/setup', { ...OWNER, email: 'x@example.com' });
    expect(again.statusCode).toBe(409);
  });

  it('sets an HttpOnly, Secure, SameSite=Lax cookie', async () => {
    const c = new Client(ctx.app);
    const r = await c.post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    expect(r.statusCode).toBe(200);
    const set = String(r.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
  });

  it('refuses everything without a session, and a forged cookie', async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get('/api/months')).statusCode).toBe(401);
    anon.cookie = 'bp_session=abc.def';
    expect((await anon.get('/api/months')).statusCode).toBe(401);
  });

  it('the owner adds a member, who signs in and sees the same planner', async () => {
    const o = new Client(ctx.app);
    await o.post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    const add = await o.post('/api/users', { name: 'Dejuania', email: 'Member@Example.com', password: 'another good password' });
    expect(add.statusCode).toBe(201);
    expect((await o.post('/api/users', { name: 'Dup', email: 'member@example.com', password: 'another good password' })).statusCode).toBe(409);
    const m = new Client(ctx.app);
    expect((await m.post('/api/auth/login', { email: 'member@example.com', password: 'another good password' })).statusCode).toBe(200);
    expect((await m.get('/api/auth/state')).json().user).toMatchObject({ name: 'Dejuania', role: 'member' });
    expect((await m.post('/api/users', { name: 'x', email: 'y@example.com', password: 'another good password' })).statusCode).toBe(403);
    expect((await m.post('/api/import', {})).statusCode).toBe(403);
    expect((await m.get('/api/users')).json().users).toHaveLength(2);
  });

  it('changing a password signs out other devices', async () => {
    const a = new Client(ctx.app), b = new Client(ctx.app);
    await a.post('/api/auth/login', { email: 'member@example.com', password: 'another good password' });
    await b.post('/api/auth/login', { email: 'member@example.com', password: 'another good password' });
    expect((await a.post('/api/auth/password', { current: 'wrong', password: 'a brand new password' })).statusCode).toBe(401);
    expect((await a.post('/api/auth/password', { current: 'another good password', password: 'a brand new password' })).statusCode).toBe(200);
    expect((await a.get('/api/months')).statusCode).toBe(200);
    expect((await b.get('/api/months')).statusCode).toBe(401);
  });

  it('members can’t delete or replace months; a junk Referer is refused, not a crash', async () => {
    const o = new Client(ctx.app);
    await o.post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    expect((await o.post('/api/months', { key: '2026-11' })).statusCode).toBe(201);
    const m = new Client(ctx.app);
    await m.post('/api/auth/login', { email: 'member@example.com', password: 'a brand new password' });
    expect((await m.del('/api/months/2026-11')).statusCode).toBe(403);
    expect((await m.post('/api/months', { key: '2026-11', from: '2026-11', replace: true })).statusCode).toBe(403);
    const r = await m.req('POST', '/api/months', { key: '2026-12' }, { origin: '', referer: 'not a url' });
    expect(r.statusCode).toBe(403);
  });

  it('writes must come from PUBLIC_URL', async () => {
    const c = new Client(ctx.app);
    await c.post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    const r = await c.req('POST', '/api/months', { key: '2026-12' }, { origin: 'https://evil.example' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain(PUBLIC_URL);
  });

  it('logout ends the session', async () => {
    const c = new Client(ctx.app);
    await c.post('/api/auth/login', { email: OWNER.email, password: OWNER.password });
    const saved = c.cookie;
    await c.post('/api/auth/logout');
    c.cookie = saved;
    expect((await c.get('/api/months')).statusCode).toBe(401);
  });

  it('a forged X-Forwarded-For doesn’t buy more guesses', async () => {
    const c = new Client(ctx.app);
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await c.req('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'x' }, { 'x-forwarded-for': `10.0.0.${i}` })).statusCode);
    expect(codes).toContain(429);
  });

  it('rate-limits login attempts', async () => {
    const c = new Client(ctx.app);
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await c.post('/api/auth/login', { email: OWNER.email, password: 'nope nope nope' })).statusCode);
    // earlier tests in this file already used some of the 6 allowed attempts
    expect(codes.every(x => x === 401 || x === 429)).toBe(true);
    expect(codes.slice(-3)).toEqual([429, 429, 429]);
    expect((await c.post('/api/auth/login', { email: OWNER.email, password: OWNER.password })).statusCode).toBe(429);
  });
});

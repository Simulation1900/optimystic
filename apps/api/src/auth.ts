import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { tx } from './db.js';

export interface User { id: number; name: string; email: string; role: 'owner' | 'member' }

declare module 'fastify' {
  interface FastifyRequest { user: User | null }
}

export const COOKIE = 'bp_session';
const SESSION_DAYS = 60;
// argon2id with OWASP's recommended minimums (19 MiB, 2 passes).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 } as const;

export const hashPassword = (pw: string) => hash(pw, ARGON);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Cookie value = token.signature, signed with SESSION_SECRET so a stolen database row alone can't be replayed. */
const sign = (token: string, secret: string) => `${token}.${createHmac('sha256', secret).update(token).digest('base64url')}`;
function unsign(value: string, secret: string): string | null {
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const token = value.slice(0, i), good = Buffer.from(sign(token, secret)), got = Buffer.from(value);
  return good.length === got.length && timingSafeEqual(good, got) ? token : null;
}

const validEmail = (e: unknown): e is string => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 10 && p.length <= 200;
const PW_RULE = 'Use a password of at least 10 characters.';

export function registerAuth(app: FastifyInstance, db: Db, cfg: Config) {
  // A real hash of a random password, checked when an email is unknown so that costs the same as a wrong password.
  const dummyHash = hashPassword(randomBytes(18).toString('base64'));
  const secure = cfg.publicUrl.startsWith('https://');

  async function startSession(reply: FastifyReply, userId: number) {
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [sha(token), userId, SESSION_DAYS]);
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    reply.setCookie(COOKIE, sign(token, cfg.sessionSecret), {
      path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 86400
    });
  }

  app.decorateRequest('user', null);
  app.addHook('onRequest', async req => {
    req.user = null;
    const raw = req.cookies[COOKIE];
    if (!raw) return;
    const token = unsign(raw, cfg.sessionSecret);
    if (!token) return;
    const r = await db.query(
      'SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()', [sha(token)]);
    if (r.rowCount) req.user = r.rows[0] as User;
  });

  const loginLimit = { config: { rateLimit: { max: cfg.loginLimit, timeWindow: '15 minutes' } } };

  app.get('/api/auth/state', async req => {
    const n = (await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n as number;
    return { needsSetup: n === 0, user: req.user };
  });

  // First run only: the person who opens the app first creates the owner login.
  app.post('/api/auth/setup', loginLimit, async (req, reply) => {
    const { name, email, password } = (req.body || {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'Enter your name.' });
    if (!validEmail(email)) return reply.code(400).send({ error: 'Enter a valid email.' });
    if (!validPassword(password)) return reply.code(400).send({ error: PW_RULE });
    const pwHash = await hashPassword(password);
    const user = await tx(db, async c => {
      await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
      if ((await c.query('SELECT 1 FROM users LIMIT 1')).rowCount) return null;
      return (await c.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, lower($2), $3, 'owner') RETURNING id, name, email, role",
        [name.trim().slice(0, 80), email, pwHash])).rows[0] as User;
    });
    if (!user) return reply.code(409).send({ error: 'This planner already has an owner. Sign in instead.' });
    await startSession(reply, user.id);
    return { user };
  });

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const { email, password } = (req.body || {}) as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string') return reply.code(400).send({ error: 'Enter your email and password.' });
    const r = await db.query('SELECT id, name, email, role, password_hash FROM users WHERE email = lower($1)', [email.trim()]);
    // Verify against a dummy hash when the email is unknown so both cases take the same time.
    const row = r.rows[0] as (User & { password_hash: string }) | undefined;
    const ok = await verify(row?.password_hash || await dummyHash, password).catch(() => false);
    if (!row || !ok) return reply.code(401).send({ error: 'That email and password don’t match.' });
    await startSession(reply, row.id);
    const { password_hash: _, ...user } = row;
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const token = raw && unsign(raw, cfg.sessionSecret);
    if (token) await db.query('DELETE FROM sessions WHERE id = $1', [sha(token)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const { current, password } = (req.body || {}) as Record<string, unknown>;
    if (!validPassword(password)) return reply.code(400).send({ error: PW_RULE });
    const row = (await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0];
    if (typeof current !== 'string' || !(await verify(row.password_hash, current).catch(() => false))) return reply.code(401).send({ error: 'Your current password is wrong.' });
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    await startSession(reply, user.id);
    return { ok: true };
  });

  app.get('/api/users', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { users: (await db.query('SELECT id, name, email, role, created_at FROM users ORDER BY id')).rows };
  });

  app.post('/api/users', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can add logins.' });
    const { name, email, password } = (req.body || {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'Enter a name.' });
    if (!validEmail(email)) return reply.code(400).send({ error: 'Enter a valid email.' });
    if (!validPassword(password)) return reply.code(400).send({ error: PW_RULE });
    try {
      const r = await db.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, lower($2), $3, 'member') RETURNING id, name, email, role",
        [name.trim().slice(0, 80), email, await hashPassword(password)]);
      return reply.code(201).send({ user: r.rows[0] });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'That email already has a login.' });
      throw e;
    }
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can remove logins.' });
    const id = Number((req.params as { id: string }).id);
    if (id === user.id) return reply.code(400).send({ error: 'You can’t remove your own login.' });
    const r = await db.query("DELETE FROM users WHERE id = $1 AND role = 'member'", [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'No such login.' });
    return { ok: true };
  });
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (!req.user) { reply.code(401).send({ error: 'Please sign in.' }); return null; }
  return req.user;
}


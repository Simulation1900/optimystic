import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig, type Config } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (n: string) => readFileSync(join(here, '../../../fixtures', n), 'utf8');

export const TEST_DB = process.env.DATABASE_URL_TEST || 'postgres://planner:planner@localhost:5432/planner_test';
export const PUBLIC_URL = 'https://planner.test:8443';

export interface Ctx { app: FastifyInstance; db: Db; cfg: Config }

/** A fresh database and server. */
export async function start(env: Record<string, string> = {}): Promise<Ctx> {
  const db = createPool(TEST_DB);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const cfg = loadConfig({ DATABASE_URL: TEST_DB, SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL, LOGIN_LIMIT: '50', ...env });
  const app = await buildServer(cfg, db);
  return { app, db, cfg };
}

export async function stop(ctx: Ctx) {
  await ctx.app.close();
  await ctx.db.end();
}

/** A signed-in client: keeps the session cookie and sends the Origin header like the browser would. */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse & { body: string; json: () => any }> {
    const res = await this.app.inject({
      method: method as 'GET', url,
      headers: { origin: PUBLIC_URL, ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).find(x => x.startsWith('bp_session='));
      if (c) this.cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    }
    return res as never;
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b: unknown = {}) => this.req('POST', u, b);
  patch = (u: string, b: unknown = {}) => this.req('PATCH', u, b);
  del = (u: string, b?: unknown) => this.req('DELETE', u, b);
}

export const OWNER = { name: 'Nate', email: 'owner@example.com', password: 'correct horse battery' };

export async function owner(ctx: Ctx): Promise<Client> {
  const c = new Client(ctx.app);
  const r = await c.post('/api/auth/setup', OWNER);
  if (r.statusCode !== 200) throw new Error(r.body);
  return c;
}

export async function withSample(ctx: Ctx): Promise<Client> {
  const c = await owner(ctx);
  const r = await c.post('/api/import', JSON.parse(fixture('sample-backup.json')));
  if (r.statusCode !== 200) throw new Error(r.body);
  return c;
}

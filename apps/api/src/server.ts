import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { registerAuth } from './auth.js';
import { registerPlanner } from './planner.js';
import { registerSync } from './sync.js';

export async function buildServer(cfg: Config, db: Db, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024,
    // Only trust X-Forwarded-For from configured proxies; otherwise anyone on the LAN could pick their own address.
    trustProxy: cfg.trustProxy
  });

  await app.register(cookie, { secret: undefined });
  await app.register(rateLimit, { global: false });

  // Writes must come from the app's own page (rule from the spec's security section).
  const allowedOrigin = cfg.publicUrl ? new URL(cfg.publicUrl).origin : null;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!allowedOrigin) return;
    let origin = req.headers.origin || '';
    if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch { origin = ''; } }
    if (origin !== allowedOrigin) return reply.code(403).send({ error: `Open the planner at ${cfg.publicUrl} to make changes.` });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    else reply.header('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return payload;
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  registerAuth(app, db, cfg);
  registerPlanner(app, db, cfg);
  registerSync(app, db, cfg);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode || 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });

  // The built web app, with every non-API path falling back to index.html.
  const dist = cfg.webDist ? resolve(cfg.webDist) : null;
  if (dist && existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: dist,
      cacheControl: false, // set below: hashed assets forever, everything else revalidated
      setHeaders: (res, path) => {
        if (/\/assets\//.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      }
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/') || req.method !== 'GET') return reply.code(404).send({ error: 'Not found.' });
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found.' }));
  }
  return app;
}

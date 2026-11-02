import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { buildServer } from './server.js';
import { startSyncSchedule } from './sync.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);

// The database container can take a moment after a reboot; retry for up to a minute.
for (let i = 0; ; i++) {
  try { await db.query('SELECT 1'); break; } catch (e) {
    if (i >= 30) throw e;
    await new Promise(r => setTimeout(r, 2000));
  }
}
const ran = await migrate(db);
const app = await buildServer(cfg, db, { logger: true });
if (ran.length) app.log.info({ migrations: ran }, 'applied database migrations');
await app.listen({ port: cfg.port, host: cfg.host });
const stopSync = startSyncSchedule(db, cfg, (msg, err) => (err ? app.log.error({ err }, msg) : app.log.info(msg)));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    stopSync();
    await app.close();
    await db.end();
    process.exit(0);
  });
}

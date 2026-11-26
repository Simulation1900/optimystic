import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { buildServer } from './server.js';
import { startSyncSchedule } from './sync.js';
import { createAgentKey } from './agentkeys.js';

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

// `node dist/index.js create-agent-key "<name>"` prints a new agent key for the owner and exits (run inside the container,
// so the key can go straight into a file on the machine that will use it).
if (process.argv[2] === 'create-agent-key') {
  const owner = (await db.query("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")).rows[0];
  if (!owner) { console.error('Set up the owner login first.'); process.exit(1); }
  process.stdout.write((await createAgentKey(db, owner.id, process.argv[3] || 'Agent')).key + '\n');
  await db.end();
  process.exit(0);
}

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

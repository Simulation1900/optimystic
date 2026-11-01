// Two quick edits to one row must both land: the second must not be refused as "someone else changed it".
import { describe, expect, it, vi } from 'vitest';
import { applyOp, clone, readBackup, targetVersion, type Month, type Op } from '@optimystic/core';
import { readFileSync } from 'node:fs';

const sample = readBackup(readFileSync(new URL('../../../fixtures/sample-backup.json', import.meta.url), 'utf8'));
const K = '2026-11';

/** A server that keeps versions like the real one: +1 on every row an op touches, 409 on a stale version. */
function fakeServer() {
  let m: Month = clone(sample.months[K]);
  const bump = (before: Month, after: Month) => {
    after.bills.forEach(b => { const o = before.bills.find(x => x.id === b.id); b.version = !o ? 1 : JSON.stringify({ ...o, version: 0 }) !== JSON.stringify({ ...b, version: 0 }) ? (o.version || 1) + 1 : o.version || 1; });
  };
  m.bills.forEach(b => { b.version = 1; });
  const payload = () => ({ key: K, months: [K], month: clone(m), totals: {}, budget: {}, heloc: {} });
  return {
    get month() { return m; },
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      await new Promise(r => setTimeout(r, 5));
      if (init?.method === 'POST' && url.endsWith('/ops')) {
        const { ops } = JSON.parse(String(init.body)) as { ops: Op[] };
        const after = clone(m);
        for (const op of ops) {
          if ('version' in op && op.version !== undefined && targetVersion(after, op) !== op.version)
            return new Response(JSON.stringify({ error: 'conflict', conflict: true, latest: payload() }), { status: 409 });
          applyOp(after, K, op);
        }
        bump(m, after); m = after;
      }
      return new Response(JSON.stringify(payload()), { status: 200 });
    })
  };
}

describe('the edit queue', () => {
  it('sends a second quick edit to the same bill without a stale version', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const store = await import('./store');
    await store.openMonth(K);
    const v = store.getState().month!.bills.find(b => b.id === 'b-mort')!.version;
    store.dispatch({ type: 'bill.update', id: 'b-mort', version: v, patch: { paid: true } });
    store.dispatch({ type: 'bill.update', id: 'b-mort', version: v, patch: { accountId: 'chk1' } }); // before the first is acked
    await vi.waitFor(() => expect(store.getState().pending).toHaveLength(0));
    expect(server.month.bills.find(b => b.id === 'b-mort')).toMatchObject({ paid: true, accountId: 'chk1' });
    expect(store.getState().toasts.filter(t => t.bad)).toEqual([]);
  });
});

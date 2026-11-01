// App state: the signed-in user, the month on screen, and edits waiting to reach the server.
//
// Every edit is a core Op. It is applied to the local copy at once (so the screen updates instantly), queued,
// and sent to the server in order. The server answers with the whole month, which replaces the local copy
// (with any still-queued ops re-applied on top). If the server refuses an op the change rolls back; a 409 means
// someone else changed that row first, so the latest month is shown instead. Offline, the queue waits in
// localStorage and is sent when the connection comes back.
import { useSyncExternalStore } from 'react';
import { applyOp, budgetStats, clone, helocCalc, monthTotals, opTarget, shortfalls, type Month, type Op } from '@optimystic/core';
import { api, ApiError, NetworkError, type MonthPayload, type User } from './api';

export type Tab = 'bills' | 'loans' | 'budget' | 'settings';
export interface Toast { id: number; text: string; bad?: boolean }
interface Pending { key: string; op: Op }

export interface State {
  phase: 'loading' | 'setup' | 'login' | 'ready';
  user: User | null;
  months: string[];
  key: string;
  /** The server's copy of the month, as last received. */
  server: MonthPayload | null;
  /** What's on screen: the server's copy plus queued edits. */
  month: Month | null;
  pending: Pending[];
  online: boolean;
  saving: boolean;
  tab: Tab;
  toasts: Toast[];
  today: string;
}

const LS = { pending: 'bp.pending', cache: 'bp.month', key: 'bp.key', tab: 'bp.tab' };
const read = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

let state: State = {
  phase: 'loading', user: null, months: [], key: read(LS.key, ''), server: null, month: null,
  pending: read<Pending[]>(LS.pending, []), online: typeof navigator === 'undefined' ? true : navigator.onLine, saving: false,
  tab: read<Tab>(LS.tab, 'bills'), toasts: [], today: new Date().toISOString().slice(0, 10)
};
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if ('pending' in patch) write(LS.pending, state.pending);
  if ('key' in patch) write(LS.key, state.key);
  if ('tab' in patch) write(LS.tab, state.tab);
  listeners.forEach(l => l());
}
export const getState = () => state;
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}

let toastN = 0;
export function toast(text: string, bad = false, ms = 4500) {
  const t = { id: ++toastN, text, bad };
  set({ toasts: [...state.toasts, t] });
  setTimeout(() => dismiss(t.id), ms);
}
export const dismiss = (id: number) => set({ toasts: state.toasts.filter(t => t.id !== id) });
export const setTab = (tab: Tab) => { set({ tab }); window.scrollTo({ top: 0 }); };

/** Local month = server month + queued ops for it. */
function rebuild(server: MonthPayload | null, pending: Pending[], key: string): Month | null {
  if (!server || server.key !== key) return state.month && pending.some(p => p.key === key) ? state.month : null;
  const m = clone(server.month);
  for (const p of pending) {
    if (p.key !== key) continue;
    try { applyOp(m, key, p.op); } catch { /* the server will refuse it too */ }
  }
  return m;
}

function receive(p: MonthPayload) {
  write(LS.cache, p);
  const pending = state.pending;
  set({ server: p, months: p.months, key: p.key, month: rebuild(p, pending, p.key) });
}

/* ---------- auth ---------- */
export async function boot() {
  try {
    const s = await api<{ needsSetup: boolean; user: User | null }>('GET', '/api/auth/state');
    if (s.needsSetup) return set({ phase: 'setup' });
    if (!s.user) return set({ phase: 'login' });
    set({ user: s.user, phase: 'ready' });
    await openLatest();
  } catch (e) {
    // Offline: show the last month viewed, read-only until the connection comes back.
    const cached = read<MonthPayload | null>(LS.cache, null);
    if (e instanceof NetworkError && cached) {
      set({ phase: 'ready', online: false, server: cached, months: cached.months, key: cached.key, month: rebuild(cached, state.pending, cached.key) });
      toast('You’re offline. Showing the last month you opened; edits will wait for a connection.');
    } else set({ phase: 'login' });
  }
}

async function openLatest() {
  const { months, today } = await api<{ months: string[]; today: string }>('GET', '/api/months');
  set({ months, today });
  if (!months.length) return set({ server: null, month: null });
  const want = months.includes(state.key) ? state.key : (months.includes(today.slice(0, 7)) ? today.slice(0, 7) : months[months.length - 1]);
  await openMonth(want);
}

export async function signedIn(user: User) {
  set({ user, phase: 'ready' });
  await openLatest();
  flush(); // edits that were waiting when the session ran out
}

export async function signOut() {
  await api('POST', '/api/auth/logout').catch(() => {});
  try { localStorage.removeItem(LS.cache); localStorage.removeItem(LS.pending); } catch { /* ignore */ }
  // The service worker keeps months for offline use; a signed-out device shouldn't.
  try { if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  set({ user: null, phase: 'login', server: null, month: null, pending: [], months: [] });
}

/* ---------- months ---------- */
export async function openMonth(key: string) {
  set({ key, month: state.server?.key === key ? state.month : null });
  try {
    receive(await api<MonthPayload>('GET', `/api/months/${key}`));
  } catch (e) { handleReadError(e); }
}

export async function refresh() {
  if (state.phase !== 'ready' || !state.key || state.saving || state.pending.length) return;
  try {
    const p = await api<MonthPayload>('GET', `/api/months/${state.key}`);
    if (!state.pending.length && !state.saving) receive(p);
    if (!state.online) set({ online: true });
  } catch (e) { handleReadError(e, true); }
}

function handleReadError(e: unknown, quiet = false) {
  if (e instanceof NetworkError) { set({ online: false }); return; }
  if (e instanceof ApiError && e.status === 401) { set({ phase: 'login', user: null }); return; }
  if (e instanceof ApiError && e.status === 404) { if (!quiet) openLatest().catch(() => {}); return; }
  if (!quiet) toast(e instanceof Error ? e.message : String(e), true);
}

/* ---------- edits ---------- */
/** Apply an edit now and send it. Throws (and changes nothing) if the core refuses it, e.g. a draw past the limit. */
export function dispatch(op: Op | Op[]) {
  const ops = Array.isArray(op) ? op : [op];
  if (!state.month) return;
  const m = clone(state.month);
  for (const o of ops) applyOp(m, state.key, o); // throws PlannerError for anything invalid
  // A second quick edit to a row that already has an edit waiting carries the version from before the first one.
  // Drop it: the waiting edit still makes the conflict check for that row, and the server applies the two in order.
  const queued = [...state.pending];
  for (const o of ops) {
    const t = opTarget(o);
    const busy = t && queued.some(p => { const q = opTarget(p.op); return p.key === state.key && q && q.table === t.table && q.id === t.id; });
    queued.push({ key: state.key, op: busy && 'version' in o ? { ...o, version: undefined } as Op : o });
  }
  set({ month: m, pending: queued });
  flush();
}

/** Run a core op locally for a preview without saving it (returns the error message, if any). */
export function check(op: Op): string | null {
  if (!state.month) return 'Not loaded.';
  try { applyOp(clone(state.month), state.key, op); return null; } catch (e) { return (e as Error).message; }
}

let flushing = false;
export async function flush() {
  if (flushing || !state.pending.length) return;
  flushing = true;
  set({ saving: true });
  try {
    while (state.pending.length) {
      const head = state.pending[0];
      try {
        const p = await api<MonthPayload>('POST', `/api/months/${head.key}/ops`, { ops: [head.op] });
        set({ pending: state.pending.slice(1), online: true });
        if (p.key === state.key) receive(p);
      } catch (e) {
        if (e instanceof NetworkError) { set({ online: false }); break; }
        if (e instanceof ApiError && e.status === 401) { set({ phase: 'login', user: null }); break; } // keep the queue for after sign-in
        set({ pending: state.pending.slice(1) });
        if (e instanceof ApiError && e.status === 409) {
          toast('Someone else changed that first, so here’s the latest. Your change wasn’t saved.', true, 7000);
          const latest = e.data.latest as MonthPayload | undefined;
          if (latest && latest.key === state.key) receive(latest);
        } else {
          toast(e instanceof Error ? e.message : String(e), true);
          if (head.key === state.key) set({ month: rebuild(state.server, state.pending, state.key) });
        }
      }
    }
  } finally {
    flushing = false;
    set({ saving: false });
  }
}

/** Server calls that aren't single-month ops (new month, import...). Their reply becomes the screen. */
export async function serverCall<T extends Partial<MonthPayload>>(method: string, url: string, body?: unknown): Promise<T> {
  const p = await api<T>(method, url, body);
  if (p && p.month && p.key) receive(p as unknown as MonthPayload);
  else if (p && Array.isArray((p as { months?: string[] }).months) && !(p as { month?: unknown }).month) {
    set({ months: (p as unknown as { months: string[] }).months });
  }
  return p;
}

export async function reloadAll() { await openLatest(); }

/* ---------- derived numbers for the screen ---------- */
export function useDerived() {
  const month = useStore(s => s.month), key = useStore(s => s.key);
  return month ? derive(month, key) : null;
}
const cache = new WeakMap<Month, ReturnType<typeof calc>>();
const calc = (m: Month, key: string) => ({ totals: monthTotals(m), budget: budgetStats(m), heloc: helocCalc(m, key), short: shortfalls(m) });
function derive(m: Month, key: string) {
  let d = cache.get(m);
  if (!d) { d = calc(m, key); cache.set(m, d); }
  return d;
}

/* ---------- staying current ---------- */
export function startSync() {
  const tick = () => { if (document.visibilityState === 'visible') { if (state.pending.length) flush(); else refresh(); } };
  const iv = setInterval(tick, 30000);
  const vis = () => { if (document.visibilityState === 'visible') tick(); };
  const on = () => { set({ online: true }); tick(); };
  const off = () => set({ online: false });
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('focus', vis);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  if (state.pending.length) flush();
  return () => { clearInterval(iv); document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', vis); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
}

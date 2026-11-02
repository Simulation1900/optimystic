import { useEffect, useState, type FormEvent } from 'react';
import { fmt, monthLabel, type MonthCheck } from '@optimystic/core';
import { api, ApiError, type User } from '../api';
import { flush, getState, reloadAll, signOut, toast, useStore } from '../store';
import { ask } from '../ui';
import { setTheme, useTheme, type Theme } from '../theme';
import { pushState, turnOff, turnOn, type PushState } from '../push';

interface ImportResult { fromFile: MonthCheck[]; fromDb: MonthCheck[]; matches: boolean; mismatches: string[]; months: string[] }

export function SettingsTab() {
  const user = useStore(s => s.user)!;
  const [result, setResult] = useState<ImportResult | null>(null);
  return (
    <>
      <div className="hhead" style={{ marginBottom: 18 }}><div><div className="eyebrow">{user.name} · {user.role}</div><h2>Settings</h2></div></div>
      {result && <ImportCheck r={result} onClose={() => setResult(null)} />}
      <div className="settings">
        <Backups isOwner={user.role === 'owner'} onImported={setResult} />
        <Logins me={user} />
        <Password />
        <Notifications />
        <CardSync isOwner={user.role === 'owner'} />
        <Appearance />
        <Install />
        <Audit />
      </div>
    </>
  );
}

function Backups({ isOwner, onImported }: { isOwner: boolean; onImported: (r: ImportResult) => void }) {
  const [busy, setBusy] = useState(false);
  async function onFile(f: File) {
    let data: unknown;
    try { data = JSON.parse(await f.text()); } catch { return toast('That file isn’t JSON. Choose a bill-planner-backup-*.json file.', true); }
    const has = getState().months.length;
    if (has && !(await ask(`Loading “${f.name}” replaces every month in the planner (${has} now) with the months in the file. Export a backup first if you might want them back.`, 'Replace everything'))) return;
    setBusy(true);
    try {
      await flush();
      const r = await api<ImportResult>('POST', '/api/import', data);
      onImported(r);
      await reloadAll();
      window.scrollTo({ top: 0 });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Couldn’t load that file.', true); } finally { setBusy(false); }
  }
  return (
    <div className="hcard">
      <h3>Backups</h3>
      <p className="hnote">The server keeps a nightly backup of the database. Export also downloads the same JSON file as the HTML planner, as a second copy you can open anywhere.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <a className="mini" href="/api/export" download style={{ textDecoration: 'none', padding: '7px 14px' }}>Export backup</a>
        {isOwner && <label className="mini" style={{ cursor: busy ? 'wait' : 'pointer', padding: '7px 14px' }}>{busy ? 'Loading…' : 'Import backup'}
          <input type="file" accept=".json,application/json" hidden disabled={busy} data-testid="backup-input" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} /></label>}
      </div>
      {!isOwner && <p className="hnote" style={{ marginTop: 10 }}>Only the owner can load a backup.</p>}
    </div>
  );
}

/** Every figure from the file next to the same figure read back from the database. */
function ImportCheck({ r, onClose }: { r: ImportResult; onClose: () => void }) {
  const rows: Array<[string, number, number]> = [];
  r.fromFile.forEach((f, i) => {
    const d = r.fromDb[i];
    const m = monthLabel(f.key);
    f.accounts.forEach((a, j) => rows.push([`${m} · ${a.name} ending balance`, a.left, d?.accounts[j]?.left]));
    rows.push([`${m} · Household left over`, f.householdLeft, d?.householdLeft]);
    f.loans.forEach((l, j) => rows.push([`${m} · ${l.name} balance`, l.balance, d?.loans[j]?.balance]));
    rows.push([`${m} · HELOC balance`, f.helocBalance, d?.helocBalance]);
    rows.push([`${m} · HELOC available`, f.helocAvailable, d?.helocAvailable]);
    rows.push([`${m} · Card budget spent`, f.budgetSpent, d?.budgetSpent]);
    rows.push([`${m} · Card budget limits`, f.budgetLimit, d?.budgetLimit]);
    rows.push([`${m} · Card bills next month`, f.cardBillsNext, d?.cardBillsNext]);
  });
  return (
    <div className="hcard" style={{ marginBottom: 20 }} data-testid="import-check">
      <h3>{r.matches ? '✓ Backup loaded. Every figure matches.' : 'Backup loaded, but some figures don’t match'}</h3>
      <p className="hnote">{r.matches
        ? `Every figure below matches to the cent, computed from the file and from what the server saved (${r.months.length} month${r.months.length > 1 ? 's' : ''}). You can start using the app.`
        : 'Don’t rely on the app yet. Keep using the HTML planner and send this list to whoever maintains the app.'}</p>
      <div className="bscroll" style={{ marginTop: 10 }}>
        <table className="checktable">
          <thead><tr><th>Figure</th><th className="r">From the file</th><th className="r">In the app</th><th /></tr></thead>
          <tbody>{rows.map(([label, a, b], i) => {
            const ok = Math.round(a * 100) === Math.round((b ?? NaN) * 100);
            return <tr key={i}><td>{label}</td><td className="r">{fmt(a)}</td><td className="r">{b === undefined ? '—' : fmt(b)}</td><td className={ok ? 'good' : 'badv'}>{ok ? '✓' : '✗'}</td></tr>;
          })}</tbody>
        </table>
      </div>
      <button className="mini" style={{ marginTop: 12 }} onClick={onClose}>Done</button>
    </div>
  );
}

function Logins({ me }: { me: User }) {
  const [users, setUsers] = useState<Array<User & { created_at: string }>>([]);
  const [err, setErr] = useState('');
  const load = () => api<{ users: Array<User & { created_at: string }> }>('GET', '/api/users').then(r => setUsers(r.users)).catch(() => {});
  useEffect(() => { load(); }, []);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    setErr('');
    try {
      await api('POST', '/api/users', Object.fromEntries(f.entries()));
      form.reset(); load(); toast('Login added. They can sign in now.');
    } catch (e2) { setErr((e2 as Error).message); }
  }
  async function remove(u: User) {
    if (!(await ask(`Remove ${u.name}’s login? They’ll be signed out everywhere.`, 'Remove'))) return;
    try { await api('DELETE', `/api/users/${u.id}`); load(); } catch (e) { toast((e as Error).message, true); }
  }
  return (
    <div className="hcard">
      <h3>Logins</h3>
      {users.map(u => (
        <div className="userrow" key={u.id}><span className="sn"><b>{u.name}</b><br /><span className="hnote">{u.email}</span></span>
          <span className="tag">{u.role}</span>
          {me.role === 'owner' && u.role !== 'owner' && <button className="link" onClick={() => remove(u)}>Remove</button>}</div>
      ))}
      {me.role === 'owner' && (
        <form className="form" onSubmit={add} style={{ marginTop: 14 }} autoComplete="off">
          <div className="settings-label" style={{ margin: 0 }}>Add a login</div>
          <label htmlFor="u-name">Name</label><input id="u-name" name="name" required />
          <label htmlFor="u-email">Email</label><input id="u-email" name="email" type="email" required />
          <label htmlFor="u-pw">Password</label><input id="u-pw" name="password" type="password" minLength={10} autoComplete="new-password" required />
          <div className="err">{err}</div>
          <button className="pbtn" style={{ marginLeft: 0 }}>Add login</button>
        </form>
      )}
    </div>
  );
}

function Password() {
  const [err, setErr] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    setErr('');
    try { await api('POST', '/api/auth/password', Object.fromEntries(f.entries())); form.reset(); toast('Password changed. Other devices were signed out.'); }
    catch (e2) { setErr((e2 as Error).message); }
  }
  return (
    <div className="hcard">
      <h3>Your login</h3>
      <form className="form" onSubmit={submit}>
        <label htmlFor="p-cur">Current password</label><input id="p-cur" name="current" type="password" autoComplete="current-password" required />
        <label htmlFor="p-new">New password</label><input id="p-new" name="password" type="password" minLength={10} autoComplete="new-password" required />
        <div className="err">{err}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="pbtn" style={{ marginLeft: 0 }}>Change password</button>
          <button type="button" className="tbtn" onClick={async () => {
            const n = getState().pending.length;
            if (n && !(await ask(`${n} edit${n > 1 ? 's haven’t' : ' hasn’t'} reached the server yet. Signing out throws ${n > 1 ? 'them' : 'it'} away.`, 'Sign out anyway'))) return;
            signOut();
          }}>Sign out</button>
        </div>
      </form>
    </div>
  );
}

function Install() {
  return (
    <div className="hcard">
      <h3>On your phone</h3>
      <p className="hnote">With Tailscale on, open this page at its HTTPS address, then:</p>
      <ul className="hnote" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
        <li><b>iPhone (Safari):</b> Share → Add to Home Screen.</li>
        <li><b>Android (Chrome):</b> ⋮ menu → Add to Home screen (or Install app).</li>
      </ul>
      <p className="hnote" style={{ marginTop: 8 }}>The last month you opened stays readable without a connection; edits made offline are sent when you’re back.</p>
    </div>
  );
}

function Audit() {
  const [entries, setEntries] = useState<Array<{ id: number; at: string; user: string | null; table_name: string; row_key: string | null; month_key: string | null; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>>([]);
  useEffect(() => { api<{ entries: typeof entries }>('GET', '/api/audit?limit=60').then(r => setEntries(r.entries)).catch(() => {}); }, []);
  const label = (e: typeof entries[number]) => String(e.after?.name ?? e.before?.name ?? e.after?.desc ?? e.before?.desc ?? e.row_key ?? '');
  const what: Record<string, string> = { accounts: 'account', bills: 'bill', transfers: 'transfer', loans: 'loan', heloc: 'HELOC', heloc_draws: 'HELOC draw', budget_cards: 'card', budget_categories: 'category', card_expenses: 'expense', months: 'month' };
  return (
    <div className="hcard">
      <h3>Recent changes</h3>
      <div className="auditlist">
        {entries.length ? entries.map(e => (
          <div key={e.id}><b>{e.user || 'Someone'}</b> {e.action.replace(/^.*:/, '').replace('insert', 'added').replace('update', 'changed').replace('delete', 'removed')} {what[e.table_name] || e.table_name} <b>{label(e)}</b>
            {e.month_key ? ` · ${monthLabel(e.month_key)}` : ''} · {new Date(e.at).toLocaleString()}</div>
        )) : <span className="hnote">Nothing yet.</span>}
      </div>
    </div>
  );
}

function Appearance() {
  const [theme] = useTheme();
  const opts: Array<[Theme, string]> = [['system', 'Match this device'], ['light', 'Light'], ['dark', 'Dark']];
  return (
    <div className="hcard">
      <h3>Appearance</h3>
      <div className="sheetlist" role="radiogroup" aria-label="Appearance">
        {opts.map(([t, label]) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
            <span className="sn">{label}</span>{theme === t && <span className="after">✓</span>}
          </button>
        ))}
      </div>
      <p className="hnote" style={{ marginTop: 10 }}>Saved on this device only, so each phone can have its own.</p>
    </div>
  );
}

interface SyncStatus {
  connected: boolean; lastSyncAt: string | null; lastError: string | null; canConnect: boolean; schedule: string[];
  lastResult: { message: string } | null;
  accounts: Array<{ id: string; name: string; org: string; balance: number | null; cardKey: string | null }>;
}

const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
const clock = (hm: string) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

/** SimpleFIN card sync: connect (owner), say which SimpleFIN account is which card, sync now. */
function CardSync({ isOwner }: { isOwner: boolean }) {
  const month = useStore(s => s.month);
  const cards = month?.budget.cards || [];
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const today = useStore(s => s.today), months = useStore(s => s.months);
  const minSince = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  // Default: the start of the planner's first month, or as far back as SimpleFIN goes.
  const [since, setSince] = useState(() => { const first = months[0] ? `${months[0]}-01` : ''; return first > minSince ? first : minSince; });
  useEffect(() => { api<SyncStatus>('GET', '/api/sync').then(setSt).catch(() => {}); }, []);
  async function call(label: string, method: string, url: string, body?: unknown) {
    setBusy(label); setErr('');
    try { setSt(await api<SyncStatus>(method, url, body)); await reloadAll(); return true; }
    catch (e) { setErr((e as Error).message); return false; }
    finally { setBusy(''); }
  }
  if (!st) return <div className="hcard"><h3>Card sync</h3><p className="hnote">Loading…</p></div>;
  return (
    <div className="hcard" data-testid="card-sync">
      <h3>Card sync</h3>
      {!st.connected ? <>
        <p className="hnote">Brings the Chase and BoA card charges into the Card budget automatically through SimpleFIN Bridge (read-only; it can’t move money). Charges already imported by CSV aren’t added twice.</p>
        {isOwner ? (st.canConnect ? (
          <form className="form" style={{ marginTop: 12 }} onSubmit={async e => { e.preventDefault(); if (await call('connect', 'POST', '/api/sync/connect', { token })) setToken(''); }}>
            <ol className="hnote" style={{ paddingLeft: 18, margin: 0 }}>
              <li>In SimpleFIN Bridge, connect only the two credit card logins.</li>
              <li>Create a setup token there and copy it.</li>
              <li>Paste it here. It only works once.</li>
            </ol>
            <label htmlFor="sf-token">Setup token</label>
            <input id="sf-token" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="aHR0cHM6Ly9…" required />
            <div className="err">{err}</div>
            <button className="pbtn" style={{ marginLeft: 0 }} disabled={!!busy}>{busy ? 'Connecting…' : 'Connect'}</button>
          </form>
        ) : <p className="hwarn">The server needs a SYNC_KEY first: add <code>SYNC_KEY=</code> (from <code>openssl rand -hex 32</code>) to the .env file and restart the app.</p>)
          : <p className="hnote" style={{ marginTop: 8 }}>Only the owner can connect it.</p>}
      </> : <>
        <p className="hnote">Syncs at {st.schedule.map(clock).join(' and ') || 'no set times'}. Last sync: <b>{ago(st.lastSyncAt)}</b>.</p>
        {st.lastResult && <p className="hnote" style={{ marginTop: 4 }} data-testid="sync-result">{st.lastResult.message}</p>}
        {st.lastError && <div className="hwarn" role="alert">{st.lastError}</div>}
        <div className="settings-label" style={{ marginTop: 14 }}>Which card is which</div>
        {st.accounts.map(a => (
          <div className="userrow" key={a.id}>
            <span className="sn"><b>{a.name}</b><br /><span className="hnote">{a.org}{a.balance !== null ? ` · balance ${fmt(a.balance)}` : ''}</span></span>
            <select aria-label={`${a.name} card`} value={a.cardKey || ''} disabled={!isOwner || !!busy}
              onChange={e => call('link', 'POST', '/api/sync/links', { links: { [a.id]: e.target.value || null } })}>
              <option value="">Ignore</option>
              {cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ))}
        <div className="err">{err}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="pbtn" style={{ marginLeft: 0 }} disabled={!!busy} onClick={() => call('run', 'POST', '/api/sync/run')}>{busy === 'run' ? 'Syncing…' : 'Sync now'}</button>
          {isOwner && <button className="tbtn danger" disabled={!!busy} onClick={async () => {
            if (await ask('Disconnect card sync? Charges already brought in stay. Also revoke the connection in the SimpleFIN Bridge dashboard.', 'Disconnect')) call('disconnect', 'DELETE', '/api/sync');
          }}>Disconnect</button>}
        </div>
        <div className="hdiv" />
        <div className="settings-label">Bring in earlier charges</div>
        <p className="hnote" style={{ margin: '0 0 8px' }}>Each sync looks back 10 days. To fill in a month that started earlier (up to about 90 days back), pick the first date you need. Charges already brought in, by sync or CSV, aren’t added again. Charges from before your first month get months of their own that only track card spending (no bills or accounts).</p>
        <form className="drawrow" style={{ gridTemplateColumns: '1fr auto' }} onSubmit={e => { e.preventDefault(); if (since) call('backfill', 'POST', '/api/sync/run', { since }); }}>
          <input type="date" aria-label="Bring in charges since" value={since} min={minSince} max={today} onChange={e => setSince(e.target.value)} required />
          <button className="mini" disabled={!!busy || !since}>{busy === 'backfill' ? 'Bringing in…' : 'Bring in'}</button>
        </form>
      </>}
    </div>
  );
}

/** Over-budget alerts on this device. */
function Notifications() {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { pushState().then(setSt).catch(() => setSt('unsupported')); }, []);
  const act = async (f: () => Promise<PushState | void>, done?: string) => {
    setBusy(true); setMsg('');
    try { const r = await f(); if (r) setSt(r); if (done) setMsg(done); }
    catch (e) { setMsg((e as Error).message || 'That didn’t work on this device.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="hcard" data-testid="notifications">
      <h3>Notifications</h3>
      <p className="hnote">A notification on this device when a synced card charge puts a budget category over its limit. The owner also hears when card sync needs attention.</p>
      <div style={{ marginTop: 12 }}>
        {st === null && <p className="hnote">Checking…</p>}
        {st === 'needs-home-screen' && <p className="hwarn">On iPhone, notifications only work in the home-screen app: Share → Add to Home Screen, open it from there, then come back here (iOS 16.4 or later).</p>}
        {st === 'unsupported' && <p className="hwarn">This browser can’t receive notifications. They need the app’s HTTPS address and a current browser.</p>}
        {st === 'blocked' && <p className="hwarn">Notifications are blocked for this site. Allow them in the phone’s or browser’s settings for this app, then reload.</p>}
        {st === 'off' && <button className="pbtn" style={{ marginLeft: 0 }} disabled={busy} onClick={() => act(turnOn, 'Notifications are on for this device.')}>{busy ? 'One moment…' : 'Turn on for this device'}</button>}
        {st === 'on' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="ok">✓ On for this device</span>
          <button className="mini" disabled={busy} onClick={() => act(async () => { await api('POST', '/api/push/test'); }, 'Test sent. It should arrive in a few seconds.')}>Send a test</button>
          <button className="tbtn" disabled={busy} onClick={() => act(turnOff, 'Notifications are off for this device.')}>Turn off</button>
        </div>}
        {msg && <p className="hnote" style={{ marginTop: 8 }} role="status">{msg}</p>}
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { monthLabel, uid } from '@optimystic/core';
import { api, ApiError, type User } from './api';
import { boot, dismiss, dispatch, openMonth, serverCall, setTab, signedIn, startSync, toast, useStore, type Tab } from './store';
import { ask, ConfirmHost, Icon } from './ui';
import { BillsTab, BillDialog, AccountDialog } from './components/Bills';
import { LoansTab } from './components/Loans';
import { BudgetTab } from './components/Budget';
import { SettingsTab } from './components/Settings';
import { NewMonthDialog } from './components/NewMonth';

export function App() {
  const phase = useStore(s => s.phase);
  useEffect(() => { boot(); return startSync(); }, []);
  return (
    <>
      {phase === 'loading' && <div className="loading">Opening the planner…</div>}
      {(phase === 'setup' || phase === 'login') && <Gate setup={phase === 'setup'} />}
      {phase === 'ready' && <Shell />}
      <Toasts />
      <ConfirmHost />
    </>
  );
}

function Gate({ setup }: { setup: boolean }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr('');
    try {
      const body = Object.fromEntries(f.entries());
      const r = await api<{ user: User }>('POST', setup ? '/api/auth/setup' : '/api/auth/login', body);
      await signedIn(r.user);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? (e2.status === 429 ? 'Too many tries. Wait a few minutes and try again.' : e2.message) : 'Can’t reach the planner. Is Tailscale on?');
    } finally { setBusy(false); }
  }
  return (
    <div className="gate">
      <form className="gatecard" onSubmit={submit}>
        <div className="eyebrow">Household bills</div>
        <h1>{setup ? 'Set up the planner' : 'Sign in'}</h1>
        <p className="lede">{setup ? 'Create the owner login. You can add a second login from Settings afterwards, then load your latest planner backup.' : 'Bill Planner for your household.'}</p>
        {setup && <><label htmlFor="g-name">Your name</label><input id="g-name" name="name" autoComplete="name" required /></>}
        <label htmlFor="g-email">Email</label>
        <input id="g-email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="g-pw">Password</label>
        <input id="g-pw" name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 10 : undefined} required />
        {setup && <p className="lede" style={{ marginTop: 6 }}>At least 10 characters.</p>}
        <div className="err" role="alert">{err}</div>
        <button className="pbtn wide" disabled={busy}>{busy ? 'One moment…' : setup ? 'Create owner login' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map(t => <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>{t.text}<button aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button></div>)}
    </div>
  );
}

const TABS: Array<[Tab, string, keyof typeof Icon]> = [['bills', 'Bills & spending', 'bills'], ['loans', 'Loans & forecasting', 'loans'], ['budget', 'Card budget', 'budget']];

function Shell() {
  const tab = useStore(s => s.tab), month = useStore(s => s.month), months = useStore(s => s.months), key = useStore(s => s.key);
  const [dlg, setDlg] = useState<null | 'bill' | 'account' | 'newMonth'>(null);
  useEffect(() => { document.title = key ? `Bills – ${monthLabel(key)}` : 'Bill Planner'; }, [key]);
  const noMonths = !months.length;
  return (
    <div className="wrap">
      <Header onAddBill={() => setDlg('bill')} onAddAccount={() => setDlg('account')} onNewMonth={() => setDlg('newMonth')} />
      <nav className="tabs top" role="tablist">
        {TABS.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{label}</button>)}
        <button role="tab" aria-selected={tab === 'settings'} className={`tab ${tab === 'settings' ? 'on' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </nav>
      {tab === 'settings' ? <SettingsTab /> : noMonths ? <FirstMonth onNew={() => setDlg('newMonth')} /> : !month ? <div className="loading">Loading {key ? monthLabel(key) : ''}…</div> : (
        <>
          {tab === 'bills' && <BillsTab />}
          {tab === 'loans' && <LoansTab />}
          {tab === 'budget' && <BudgetTab />}
        </>
      )}
      <nav className="tabbar" aria-label="Sections">
        {TABS.map(([t, label, ic]) => <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{Icon[ic]}<span>{label.split(' ')[0]}</span></button>)}
        <button className={tab === 'settings' ? 'on' : ''} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>{Icon.settings}<span>Settings</span></button>
      </nav>
      {dlg === 'bill' && <BillDialog bill={null} onClose={() => setDlg(null)} />}
      {dlg === 'account' && <AccountDialog onClose={() => setDlg(null)} />}
      {dlg === 'newMonth' && <NewMonthDialog onClose={() => setDlg(null)} />}
    </div>
  );
}

function FirstMonth({ onNew }: { onNew: () => void }) {
  return (
    <div className="hcard" style={{ maxWidth: 560, margin: '20px 0' }}>
      <h3>Nothing here yet</h3>
      <p className="hnote">Load your latest <code>bill-planner-backup-*.json</code> from Settings → Backups to bring over everything from the HTML planner, or start an empty month.</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="pbtn" style={{ marginLeft: 0 }} onClick={() => setTab('settings')}>Load a backup</button>
        <button className="tbtn" onClick={onNew}>Start an empty month</button>
      </div>
    </div>
  );
}

function Header({ onAddBill, onAddAccount, onNewMonth }: { onAddBill: () => void; onAddAccount: () => void; onNewMonth: () => void }) {
  const key = useStore(s => s.key), months = useStore(s => s.months), online = useStore(s => s.online), saving = useStore(s => s.saving);
  const pending = useStore(s => s.pending.length), user = useStore(s => s.user), tab = useStore(s => s.tab);
  const i = months.indexOf(key);
  async function delMonth() {
    if (months.length <= 1 || !(await ask(`Delete ${monthLabel(key)} and everything in it?`, 'Delete month'))) return;
    try {
      const r = await serverCall<{ months: string[] }>('DELETE', `/api/months/${key}`);
      await openMonth(r.months[Math.max(0, i - 1)] || r.months[0]);
    } catch (e) { toast((e as Error).message, true); }
  }
  const status = !online ? `Offline${pending ? ` · ${pending} waiting` : ''}` : saving || pending ? 'Saving…' : 'Saved';
  return (
    <header>
      <div>
        <div className="eyebrow">Household bills {user && <span className="who">· {user.name}</span>}</div>
        {key ? (
          <div className="monthnav">
            <button className="arrow" title="Previous month" aria-label="Previous month" disabled={i <= 0} onClick={() => openMonth(months[i - 1])}>‹</button>
            <h1><span>{monthLabel(key)}</span><span className="caret">▾</span>
              <select title="Switch month" aria-label="Switch month" value={key} onChange={e => openMonth(e.target.value)}>
                {months.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
              </select></h1>
            <button className="arrow" title="Next month" aria-label="Next month" disabled={i < 0 || i >= months.length - 1} onClick={() => openMonth(months[i + 1])}>›</button>
          </div>
        ) : <div className="monthnav"><h1>Bill Planner</h1></div>}
      </div>
      <div className="tools">
        <span className={`syncpill ${!online ? 'offline' : saving || pending ? 'saving' : ''}`} role="status"><i />{status}</span>
        {key && tab === 'bills' && <>
          <button className="tbtn" onClick={onAddBill}>Add bill</button>
          <button className="tbtn wide-only" onClick={onAddAccount}>Add account</button>
        </>}
        {key && <>
          <span className="sep" />
          {user?.role === 'owner' && <button className="tbtn danger wide-only" disabled={months.length <= 1} onClick={delMonth}>Delete month</button>}
        </>}
        <button className="pbtn" onClick={onNewMonth}>New month</button>
      </div>
    </header>
  );
}

export { dispatch, uid };

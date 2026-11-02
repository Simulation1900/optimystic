import { useMemo, useState, type FormEvent } from 'react';
import { addMonths, budgetStats, fmt, monthLabel } from '@optimystic/core';
import { ApiError } from '../api';
import { flush, getState, serverCall, setTab, toast, useStore } from '../store';
import { ask, Modal } from '../ui';

export function NewMonthDialog({ onClose }: { onClose: () => void }) {
  const months = useStore(s => s.months), key = useStore(s => s.key), month = useStore(s => s.month), today = useStore(s => s.today);
  const last = months[months.length - 1];
  const [target, setTarget] = useState(last ? addMonths(last, 1) : today.slice(0, 7));
  const [from, setFrom] = useState(key || last || '');
  const [balances, setBalances] = useState('forecast');
  const [cards, setCards] = useState(from && from < today.slice(0, 7) ? 'actual' : 'projected');
  const [one, setOne] = useState(false);
  const [busy, setBusy] = useState(false);

  // The note can only preview the month on screen (other months aren't loaded); the server uses the real source.
  const note = useMemo(() => {
    const stmt = (month?.budget.cards || []).filter(c => c.closeDay).map(c => c.name);
    if (stmt.length && cards !== 'keep') return `${stmt.join(' and ')} ${stmt.length > 1 ? 'follow their statements' : 'follows its statement'} (the one closing that month); other cards: ${cards === 'actual' ? 'actual spending' : 'projected spending'}.`;
    if (cards === 'keep') return 'Card bills keep their current amounts.';
    if (!month || from !== key) return `Each card’s linked bill becomes its ${cards === 'actual' ? 'actual spending' : 'projected spending'} in ${from ? monthLabel(from) : 'that month'}.`;
    const cs = budgetStats(month);
    const parts = cs.cards.filter(c => c.billName).map(c => `“${c.billName}” → ${fmt(cards === 'actual' ? c.spent : c.projected)}`);
    return parts.length ? parts.join(' · ') : 'No cards are linked to bills yet (set this on the Card budget tab).';
  }, [cards, month, from, key]);

  async function create(replace: boolean) {
    setBusy(true);
    try {
      await flush();
      if (getState().pending.length) { toast('Some edits are still waiting to be saved. Try again when you’re back online.', true); return; }
      await serverCall('POST', '/api/months', { key: target, from: from || undefined, balances, cardBills: cards, copyOneTime: one, replace });
      toast(`${monthLabel(target)} is ready.`);
      setTab('bills');
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.exists) {
        if (await ask(`${monthLabel(target)} already exists. Replace it with a copy?`, 'Replace')) return create(true);
      } else toast((e as Error).message, true);
    } finally { setBusy(false); }
  }

  function submit(e: FormEvent) { e.preventDefault(); if (target) create(false); }

  return (
    <Modal onClose={onClose} label="Start a new month">
      <form onSubmit={submit}>
        <h3>Start a new month</h3>
        <p className="lede">Monthly bills keep their accounts and amounts. Everything starts unpaid.</p>
        <div className="two">
          <div><label htmlFor="nmMonth">New month</label><input type="month" id="nmMonth" value={target} onChange={e => setTarget(e.target.value)} required /></div>
          <div><label htmlFor="nmFrom">Copy from</label>
            <select id="nmFrom" value={from} onChange={e => setFrom(e.target.value)} disabled={!months.length}>
              {!months.length && <option value="">(empty month)</option>}
              {months.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
            </select></div>
        </div>
        {months.length > 0 && <>
          <label htmlFor="nmBal">Starting balances</label>
          <select id="nmBal" value={balances} onChange={e => setBalances(e.target.value)}>
            <option value="forecast">Ending balances: each account’s ending balance this month</option>
            <option value="same">Same as the month I’m copying</option>
            <option value="zero">Start at $0 (I’ll type them in)</option>
          </select>
          <p className="lede" style={{ marginTop: 8 }}>Each account’s saved monthly deposits, monthly transfers and the HELOC details carry over too.</p>
          <label htmlFor="nmCards">Credit card bills</label>
          <select id="nmCards" value={cards} onChange={e => setCards(e.target.value)}>
            <option value="projected">Projected: spent so far + what’s left in each budget category</option>
            <option value="actual">What was actually spent on each card</option>
            <option value="keep">Keep the same amounts</option>
          </select>
          <p className="lede" style={{ marginTop: 6 }}>{note}</p>
          <label className="chkrow" style={{ marginTop: 8 }}><input type="checkbox" checked={one} onChange={e => setOne(e.target.checked)} /> Also copy one-time expenses</label>
        </>}
        <div className="dlgbtns">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="pbtn" disabled={busy}>{busy ? 'Creating…' : 'Create month'}</button>
        </div>
      </form>
    </Modal>
  );
}

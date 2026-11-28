import { useEffect, useState, type FormEvent } from 'react';
import { acctStats, cents, EXTERNAL, fmt, monthLabel, r2, surplusAccounts, uid, type Month, type Transfer } from '@optimystic/core';
import { dispatch, toast, useStore } from '../store';
import { ask, Modal } from '../ui';

const run = (f: () => void) => { try { f(); } catch (e) { toast((e as Error).message, true); } };

export interface TransferPreset { fromId?: string; toId?: string; amount?: number; note?: string }

/* Any screen can open the transfer dialog (header button, short accounts, Cover shortfalls). */
type Open = { transfer: Transfer | null; preset: TransferPreset };
let openListener: ((o: Open) => void) | null = null;
export const openTransfer = (preset: TransferPreset = {}, transfer: Transfer | null = null) => openListener?.({ transfer, preset });

/** Opens an external deposit (money from outside the household) into an account. */
export const openDeposit = (toId: string) => openTransfer({ fromId: EXTERNAL, toId });

/** Opens a transfer that covers an account's shortfall, from the account with the most to spare. */
export function coverWithTransfer(m: Month, toId: string, need: number) {
  const from = surplusAccounts(m, toId)[0];
  openTransfer({ toId, fromId: from?.account.id, amount: need, note: 'Cover shortfall' });
}

export function TransferHost() {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => { openListener = setOpen; return () => { openListener = null; }; }, []);
  return open ? <TransferDialog transfer={open.transfer} preset={open.preset} onClose={() => setOpen(null)} /> : null;
}

function TransferDialog({ transfer: t, preset, onClose }: { transfer: Transfer | null; preset: TransferPreset; onClose: () => void }) {
  const month = useStore(s => s.month)!, key = useStore(s => s.key);
  const accts = month.accounts;
  // With one account, the only money that can come in is from outside: an external deposit.
  const from0 = t ? t.fromId : preset.fromId ?? (accts.length > 1 ? accts[0].id : EXTERNAL);
  const [fromId, setFrom] = useState(from0);
  const [toId, setTo] = useState(t?.toId || preset.toId || accts.find(a => a.id !== from0)?.id || '');
  const ext = fromId === EXTERNAL;
  const [amount, setAmount] = useState(t ? t.amount.toFixed(2) : preset.amount ? preset.amount.toFixed(2) : '');
  const [note, setNote] = useState(t?.note ?? preset.note ?? '');
  const [recurring, setRecurring] = useState(t ? t.recurring : false);

  // What each side would have left with this transfer in place of the one being edited.
  const amt = Math.abs(cents(amount));
  const leftOf = (id: string) => {
    const s = getStateLeft(month, id, t);
    return r2(s + (id === toId ? amt : 0) - (id === fromId ? amt : 0));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (t) dispatch({ type: 'transfer.update', id: t.id, version: t.version, patch: { fromId, toId, amount, note, recurring } });
      else dispatch({ type: 'transfer.add', id: uid(), fromId, toId, amount, note, recurring });
      onClose();
    } catch (err) { toast((err as Error).message, true); }
  }
  async function del() {
    if (t && await ask(`Delete this ${fmt(t.amount)} ${t.fromId === EXTERNAL ? 'external deposit' : 'transfer'} from ${monthLabel(key)}?`, 'Delete')) {
      run(() => dispatch({ type: 'transfer.remove', id: t.id, version: t.version }));
      onClose();
    }
  }
  if (!accts.length) {
    return (
      <Modal onClose={onClose} label="Transfer">
        <h3>Transfer</h3><p className="lede">Add an account first.</p>
        <div className="dlgbtns"><button type="button" className="ghost" onClick={onClose}>OK</button></div>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose} label={ext ? (t ? 'Edit external deposit' : 'New external deposit') : t ? 'Edit transfer' : 'New transfer'}>
      <form onSubmit={submit}>
        <h3>{ext ? (t ? 'Edit external deposit' : 'External deposit') : t ? 'Edit transfer' : 'Move money between accounts'}</h3>
        <p className="lede">{ext
          ? 'Money coming in from outside the household (a refund, a gift, a side job) on top of the account’s monthly deposits. It adds to the account’s ending balance; tick it done once it’s in.'
          : 'Counts against the “from” account and adds to the “to” account’s ending balance. Balances stay as the bank shows them; tick it done once it’s made.'}</p>
        <div className="two">
          <div><label htmlFor="tFrom">From</label>
            <select id="tFrom" value={fromId} onChange={e => setFrom(e.target.value)}>
              <option value={EXTERNAL}>External (outside the household)</option>
              {accts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div><label htmlFor="tTo">To</label>
            <select id="tTo" value={toId} onChange={e => setTo(e.target.value)}>{accts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        </div>
        <label htmlFor="tAmt">Amount</label>
        <input id="tAmt" type="text" inputMode="decimal" placeholder="0.00" required value={amount} onChange={e => setAmount(e.target.value)} autoFocus={!t && !preset.amount} />
        {toId && fromId !== toId && amt > 0 && (
          <p className="lede num" data-testid="transfer-preview" style={{ marginTop: 8 }}>
            {ext ? 'Ending balance' : 'Ending balances'}: {!ext && <>{accts.find(a => a.id === fromId)?.name} <b className={leftOf(fromId) < 0 ? 'neg' : ''}>{fmt(leftOf(fromId))}</b> ·{' '}</>}
            {accts.find(a => a.id === toId)?.name} <b className={leftOf(toId) < 0 ? 'neg' : ''}>{fmt(leftOf(toId))}</b>
          </p>
        )}
        {fromId === toId && <p className="hwarn">Pick two different accounts.</p>}
        <label htmlFor="tNote">Note</label>
        <input id="tNote" type="text" placeholder={ext ? 'Optional, e.g. Tax refund' : 'Optional, e.g. Cover the card bill'} value={note} onChange={e => setNote(e.target.value)} />
        <label className="chkrow"><input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} /> Every month</label>
        <p className="lede" style={{ margin: '4px 0 0 26px' }}>{ext ? 'Monthly external deposits' : 'Monthly transfers'} are copied into each new month.</p>
        <div className="dlgbtns">
          {t && <button type="button" className="del" onClick={del}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="pbtn" disabled={fromId === toId}>{t ? 'Save' : ext ? 'Add deposit' : 'Add transfer'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** An account's left-after-bills without the transfer being edited (so the preview doesn't count it twice). */
function getStateLeft(m: Month, id: string, editing: Transfer | null): number {
  const a = m.accounts.find(x => x.id === id);
  return a ? acctStats({ ...m, transfers: m.transfers.filter(x => x !== editing) }, a).left : 0;
}

/** This month's transfers, on the Bills tab. */
export function TransfersPanel({ month }: { month: Month }) {
  const name = (id: string) => id === EXTERNAL ? 'External' : month.accounts.find(a => a.id === id)?.name || '?';
  const color = (id: string) => month.accounts.find(a => a.id === id)?.color;
  if (!month.transfers.length) return null;
  return (
    <section className="hcard transfers" aria-label="Transfers and external deposits">
      <div className="charthead"><h3>{month.transfers.some(t => t.fromId === EXTERNAL) ? 'Transfers & deposits' : 'Transfers'}</h3><button className="linkbtn" onClick={() => openTransfer()}>+ Add transfer</button></div>
      {month.transfers.map(t => (
        <div key={t.id} className={`xrow ${t.done ? 'done' : ''}`} data-transfer={t.id}>
          <input type="checkbox" className="chk" checked={t.done} aria-label={`Mark ${fmt(t.amount)} ${t.fromId === EXTERNAL ? 'deposit' : 'transfer'} done`} title="Mark done"
            onChange={e => run(() => dispatch({ type: 'transfer.update', id: t.id, version: t.version, patch: { done: e.target.checked } }))} />
          <span className="xpath">{t.fromId !== EXTERNAL && <span className="dot" style={{ background: color(t.fromId) }} />}{name(t.fromId)} <span className="arrowx">→</span> <span className="dot" style={{ background: color(t.toId) }} />{name(t.toId)}
            {(t.note || t.recurring) && <span className="xmeta">{[t.note, t.recurring ? 'Every month' : ''].filter(Boolean).join(' · ')}</span>}</span>
          <b className="num amt">{fmt(t.amount)}</b>
          <button className="mini" onClick={() => openTransfer({}, t)}>Edit</button>
        </div>
      ))}
    </section>
  );
}


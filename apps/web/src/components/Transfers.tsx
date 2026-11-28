import { useEffect, useState, type FormEvent } from 'react';
import { acctStats, cents, EXTERNAL, fmt, helocBill, helocNextPayment, monthLabel, r2, surplusAccounts, uid, type Month, type Transfer } from '@optimystic/core';
import { dispatch, toast, useStore } from '../store';
import { ask, Modal } from '../ui';

const run = (f: () => void) => { try { f(); } catch (e) { toast((e as Error).message, true); } };

/**
 * "From the HELOC" in the dialog. Not a transfer: it makes a HELOC draw (the same as the Loans tab's),
 * which adds to the account's balance and the HELOC balance right away.
 */
export const HELOC_SOURCE = '__heloc';

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

/** The month a payment estimate is for, short: "Dec". */
const monShort = (key: string) => monthLabel(key).split(' ')[0].slice(0, 3);

function TransferDialog({ transfer: t, preset, onClose }: { transfer: Transfer | null; preset: TransferPreset; onClose: () => void }) {
  const month = useStore(s => s.month)!, key = useStore(s => s.key);
  const accts = month.accounts;
  const h = month.heloc;
  // A HELOC draw is offered for new money only (an existing transfer stays a transfer).
  const helocOn = !t && (Number(h.limit) || 0) > 0;
  const avail = Number(h.available) || 0;
  // With one account, the only money that can come in is from outside: an external deposit.
  const from0 = t ? t.fromId : preset.fromId ?? (accts.length > 1 ? accts[0].id : EXTERNAL);
  const [fromId, setFrom] = useState(from0);
  const [toId, setTo] = useState(t?.toId || preset.toId || accts.find(a => a.id !== from0)?.id || '');
  const ext = fromId === EXTERNAL;
  const heloc = fromId === HELOC_SOURCE;
  const [amount, setAmount] = useState(t ? t.amount.toFixed(2) : preset.amount ? preset.amount.toFixed(2) : '');
  const [note, setNote] = useState(t?.note ?? preset.note ?? '');
  const [recurring, setRecurring] = useState(t ? t.recurring : false);

  // What each side would have left with this transfer in place of the one being edited.
  const amt = Math.abs(cents(amount));
  const leftOf = (id: string) => {
    const s = getStateLeft(month, id, t);
    return r2(s + (id === toId ? amt : 0) - (id === fromId ? amt : 0));
  };

  // The HELOC's next payment now and with this draw, and whether this month's HELOC bill can follow it.
  const payNow = helocNextPayment(month, key);
  const payAfter = helocNextPayment(month, key, amt);
  const hb = helocBill(month);
  const billFollows = !!hb && !hb.paid && payAfter.key === key;
  const [setBill, setSetBill] = useState(true);
  const tooMuch = heloc && amt > avail + 0.001;

  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (heloc) {
        dispatch({ type: 'heloc.draw', id: uid(), acctId: toId, amount: amt });
        if (billFollows && setBill) dispatch({ type: 'heloc.setBill', amount: payAfter.amount });
      } else if (t) dispatch({ type: 'transfer.update', id: t.id, version: t.version, patch: { fromId, toId, amount, note, recurring } });
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
  const title = heloc ? 'Draw on the HELOC' : ext ? (t ? 'Edit external deposit' : 'External deposit') : t ? 'Edit transfer' : 'Move money between accounts';
  return (
    <Modal onClose={onClose} label={heloc ? 'New HELOC draw' : ext ? (t ? 'Edit external deposit' : 'New external deposit') : t ? 'Edit transfer' : 'New transfer'}>
      <form onSubmit={submit}>
        <h3>{title}</h3>
        <p className="lede">{heloc
          ? 'Borrows from the HELOC into the account: it’s added to the account’s balance now and to what you owe on the HELOC (the same as a draw on the Loans tab). Undo it from the list if you change your mind.'
          : ext
            ? 'Money coming in from outside the household (a refund, a gift, a side job) on top of the account’s monthly deposits. It adds to the account’s ending balance; tick it done once it’s in.'
            : 'Counts against the “from” account and adds to the “to” account’s ending balance. Balances stay as the bank shows them; tick it done once it’s made.'}</p>
        <div className="two">
          <div><label htmlFor="tFrom">From</label>
            <select id="tFrom" value={fromId} onChange={e => setFrom(e.target.value)}>
              <option value={EXTERNAL}>External (outside the household)</option>
              {helocOn && <option value={HELOC_SOURCE}>HELOC ({fmt(avail)} available)</option>}
              {accts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div><label htmlFor="tTo">To</label>
            <select id="tTo" value={toId} onChange={e => setTo(e.target.value)}>{accts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        </div>
        <label htmlFor="tAmt">Amount</label>
        <input id="tAmt" type="text" inputMode="decimal" placeholder="0.00" required value={amount} onChange={e => setAmount(e.target.value)} autoFocus={!t && !preset.amount} />
        {toId && fromId !== toId && amt > 0 && (
          <p className="lede num" data-testid="transfer-preview" style={{ marginTop: 8 }}>
            {ext || heloc ? 'Ending balance' : 'Ending balances'}: {!ext && !heloc && <>{accts.find(a => a.id === fromId)?.name} <b className={leftOf(fromId) < 0 ? 'neg' : ''}>{fmt(leftOf(fromId))}</b> ·{' '}</>}
            {accts.find(a => a.id === toId)?.name} <b className={leftOf(toId) < 0 ? 'neg' : ''}>{fmt(leftOf(toId))}</b>
          </p>
        )}
        {heloc && (
          <div className="hcard" data-testid="heloc-preview" style={{ marginTop: 8, padding: '10px 12px' }}>
            <div className="kv"><span>HELOC balance</span><b className="num">{fmt(h.balance)} → {fmt(r2((Number(h.balance) || 0) + amt))}</b></div>
            <div className="kv"><span>Next payment ({monShort(payAfter.key)})</span>
              <b className="num" data-testid="heloc-next-payment">≈ {fmt(payAfter.amount)}{amt > 0 && payAfter.amount !== payNow.amount && <span className="lede"> (was {fmt(payNow.amount)})</span>}</b></div>
            <div className="hnote">{payAfter.interestOnly
              ? `Interest only during the draw period: balance × ${h.rate}% × days in ${monthLabel(payAfter.key)} ÷ 365. Assumes the rate stays the same.`
              : 'Principal and interest over the repayment months left. Assumes the rate stays the same.'}</div>
            {billFollows && amt > 0 && (
              <label className="chkrow" style={{ marginTop: 6 }}><input type="checkbox" checked={setBill} onChange={e => setSetBill(e.target.checked)} /> Set the “{hb!.name}” bill to {fmt(payAfter.amount)}</label>
            )}
          </div>
        )}
        {tooMuch && <p className="hwarn">Only {fmt(avail)} is available on the HELOC.</p>}
        {fromId === toId && <p className="hwarn">Pick two different accounts.</p>}
        {!heloc && <>
          <label htmlFor="tNote">Note</label>
          <input id="tNote" type="text" placeholder={ext ? 'Optional, e.g. Tax refund' : 'Optional, e.g. Cover the card bill'} value={note} onChange={e => setNote(e.target.value)} />
          <label className="chkrow"><input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} /> Every month</label>
          <p className="lede" style={{ margin: '4px 0 0 26px' }}>{ext ? 'Monthly external deposits' : 'Monthly transfers'} are copied into each new month.</p>
        </>}
        <div className="dlgbtns">
          {t && <button type="button" className="del" onClick={del}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="pbtn" disabled={fromId === toId || tooMuch}>{t ? 'Save' : heloc ? 'Draw' : ext ? 'Add deposit' : 'Add transfer'}</button>
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

/** This month's transfers, external deposits and HELOC draws, on the Bills tab. */
export function TransfersPanel({ month }: { month: Month }) {
  const name = (id: string) => id === EXTERNAL ? 'External' : month.accounts.find(a => a.id === id)?.name || '?';
  const color = (id: string) => month.accounts.find(a => a.id === id)?.color;
  const draws = month.heloc.draws || [];
  if (!month.transfers.length && !draws.length) return null;
  const title = month.transfers.some(t => t.fromId === EXTERNAL) || draws.length ? 'Transfers & deposits' : 'Transfers';
  return (
    <section className="hcard transfers" aria-label="Transfers, external deposits and HELOC draws">
      <div className="charthead"><h3>{title}</h3><button className="linkbtn" onClick={() => openTransfer()}>+ Add transfer</button></div>
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
      {draws.map(d => (
        <div key={d.id} className="xrow draw" data-draw={d.id}>
          <span className="xpath">HELOC <span className="arrowx">→</span> <span className="dot" style={{ background: color(d.acctId) }} />{name(d.acctId)}
            <span className="xmeta">Draw · in the balance and owed on the HELOC</span></span>
          <b className="num amt">{fmt(d.amount)}</b>
          <button className="mini" onClick={async () => {
            if (await ask(`Undo this ${fmt(d.amount)} HELOC draw? It comes back out of ${name(d.acctId)} and off the HELOC balance.`, 'Undo draw'))
              run(() => dispatch({ type: 'heloc.undoDraw', id: d.id }));
          }}>Undo</button>
        </div>
      ))}
    </section>
  );
}

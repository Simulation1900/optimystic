import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cents, fmt, r2 } from '@optimystic/core';

export const Money = ({ v, color, className = '' }: { v: number; color?: boolean; className?: string }) => (
  <span className={`num ${className} ${color ? (v < 0 ? 'neg' : 'pos') : ''}`}>{fmt(v)}</span>
);

/**
 * A text field that edits a value and commits it on blur or Enter (not on every keystroke, so a phone
 * doesn't send a request per digit). `format` is what's shown when not focused.
 */
export function Field({ value, onCommit, format = v => String(v ?? ''), onLive, ...rest }:
  { value: unknown; onCommit: (text: string) => void; format?: (v: unknown) => string; onLive?: (text: string) => void }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(format(value));
  const [focused, setFocused] = useState(false);
  const last = useRef(format(value));
  useEffect(() => { if (!focused) { setText(format(value)); last.current = format(value); } }, [value, focused]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => { if (text !== last.current) { last.current = text; onCommit(text); } };
  return (
    <input
      {...rest}
      value={text}
      onFocus={e => { setFocused(true); rest.onFocus?.(e); }}
      onChange={e => { setText(e.target.value); onLive?.(e.target.value); }}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(last.current); setTimeout(() => (e.target as HTMLInputElement).blur()); } }}
    />
  );
}
export const money2 = (v: unknown) => (Number(v) || 0).toFixed(2);
export const moneyOrBlank = (v: unknown) => (Number(v) ? Number(v).toFixed(2) : '');
export const parseMoney = (t: string) => Math.abs(cents(t));
export { cents, r2 };

/** A <dialog> that opens as a modal while mounted. */
export function Modal({ onClose, children, sheet = false, label }: { onClose: () => void; children: ReactNode; sheet?: boolean; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const cancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', cancel);
    return () => d.removeEventListener('cancel', cancel);
  }, [onClose]);
  return (
    <dialog ref={ref} className={sheet ? 'sheet' : ''} aria-label={label}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      {children}
    </dialog>
  );
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q), f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}
export const usePhone = () => useMedia('(max-width: 700px)');
export const useTouch = () => useMedia('(hover: none)');

/** A confirm dialog in place of window.confirm (which iOS home-screen apps handle badly). */
let confirmImpl: ((msg: string, ok?: string) => Promise<boolean>) | null = null;
export const setConfirm = (f: typeof confirmImpl) => { confirmImpl = f; };
export const ask = (msg: string, ok = 'OK') => (confirmImpl ? confirmImpl(msg, ok) : Promise.resolve(window.confirm(msg)));

export function ConfirmHost() {
  const [q, setQ] = useState<{ msg: string; ok: string; done: (v: boolean) => void } | null>(null);
  useEffect(() => { setConfirm((msg, ok = 'OK') => new Promise(done => setQ({ msg, ok, done }))); return () => setConfirm(null); }, []);
  if (!q) return null;
  const close = (v: boolean) => { q.done(v); setQ(null); };
  return (
    <Modal onClose={() => close(false)} label="Confirm">
      <p style={{ whiteSpace: 'pre-line', margin: '0 0 4px', fontSize: 15 }}>{q.msg}</p>
      <div className="dlgbtns">
        <button type="button" className="ghost" onClick={() => close(false)}>Cancel</button>
        <button type="button" className="pbtn" autoFocus onClick={() => close(true)}>{q.ok}</button>
      </div>
    </Modal>
  );
}

export const Icon = {
  bills: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18M7 15h4"/></svg>,
  loans: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 20h18M5 20V10l7-5 7 5v10"/><path d="M10 20v-5h4v5"/></svg>,
  budget: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12l6 6"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
};

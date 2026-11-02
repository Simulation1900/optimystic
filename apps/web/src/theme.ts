// Light / dark: follow the device ("system"), or a choice saved on this device.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'bp.theme';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

const systemDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
/** What's actually on screen right now. */
export const effectiveTheme = (t = getTheme()): 'light' | 'dark' => (t === 'system' ? (systemDark() ? 'dark' : 'light') : t);

export function applyTheme(t = getTheme()) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  // Phone status bar / browser chrome color
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = effectiveTheme(t) === 'dark' ? '#151411' : '#f5f2ec';
  document.head.appendChild(meta);
}

export function setTheme(t: Theme) {
  try { if (t === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* private mode */ }
  applyTheme(t);
  listeners.forEach(l => l());
}

if (typeof matchMedia !== 'undefined') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'system') { applyTheme(); listeners.forEach(l => l()); } });
}

export const useTheme = () => useSyncExternalStore(
  l => { listeners.add(l); return () => { listeners.delete(l); }; },
  () => `${getTheme()}:${effectiveTheme()}`
).split(':') as [Theme, 'light' | 'dark'];

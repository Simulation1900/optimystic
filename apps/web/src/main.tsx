import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/inter/index.css';
import './planner.css';
import './app.css';
import { App } from './App';
import { applyTheme } from './theme';
import { setTab, type Tab } from './store';

applyTheme(); // before the first paint, so a chosen theme doesn't flash

// A tapped notification opens /?tab=budget (or settings): go there, then tidy the address.
const openFromUrl = (href: string) => {
  const t = new URL(href, location.href).searchParams.get('tab');
  if (t && ['bills', 'loans', 'budget', 'settings'].includes(t)) setTab(t as Tab);
};
openFromUrl(location.href);
if (location.search) history.replaceState(null, '', location.pathname);
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') openFromUrl(e.data.url); });

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Offline support and "Add to Home Screen". Browsers only allow this over HTTPS (or on localhost).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

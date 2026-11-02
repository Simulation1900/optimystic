import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/inter/index.css';
import './planner.css';
import './app.css';
import { App } from './App';
import { applyTheme } from './theme';

applyTheme(); // before the first paint, so a chosen theme doesn't flash

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Offline support and "Add to Home Screen". Browsers only allow this over HTTPS (or on localhost).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

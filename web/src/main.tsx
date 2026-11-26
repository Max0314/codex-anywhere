import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { OwnerShell } from './owner-shell';
import { takePairingInput } from './pairing-input';
import './styles.scss';
import './owner-theme.css';

void removeObsoleteWorkers().catch(() => undefined);

let pairingStorage: Storage | undefined;
try { pairingStorage = sessionStorage; } catch { /* blocked store */ }
const owner = Boolean(window.__CODEX_ANYWHERE_CONFIG__?.owner);
const initialPairingInput = owner ? null : takePairingInput(location, history, pairingStorage);
if (owner && location.hash) history.replaceState(null, '', location.pathname + location.search);
if (owner) { const script = document.createElement('script'); script.src = '/_fribench/client.js'; script.defer = true; document.head.appendChild(script); }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {owner ? <OwnerShell><App initialPairingInput={null} /></OwnerShell> : <App initialPairingInput={initialPairingInput} /> }
  </StrictMode>,
);

async function removeObsoleteWorkers() {
  try { localStorage.removeItem('codex-anywhere.notifications.enabled'); } catch { /* blocked storage */ }
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

// Turning notifications on and off for this device.
import { api } from './api';

export type PushState = 'unsupported' | 'needs-home-screen' | 'blocked' | 'off' | 'on';

const isiOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

const keyBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iPhones only offer web push to the home-screen app (iOS 16.4 and later).
    return isiOS() && !standalone() ? 'needs-home-screen' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Must be called from a tap (browsers only ask for permission then). */
export async function turnOn(): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // a subscription made with another key (e.g. the server was set up again) can't receive our messages
    const k = sub.options.applicationServerKey;
    const same = k && btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === publicKey;
    if (!same) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  return 'on';
}

export async function turnOff(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  return 'off';
}

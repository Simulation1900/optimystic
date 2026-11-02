// SimpleFIN Bridge client (https://www.simplefin.org/protocol.html): read-only access to the two credit cards.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SfTransaction } from '@optimystic/core';

export class SyncError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/* ---------- the access URL is a password: keep it encrypted at rest ---------- */
const keyOf = (secret: string) => createHash('sha256').update('bill-planner-sync:' + secret).digest();

export function encrypt(plain: string, secret: string): string {
  if (!secret) throw new SyncError('Set SYNC_KEY in the server’s .env (openssl rand -hex 32), restart, then connect again.', 503);
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(enc: string, secret: string): string {
  if (!secret) throw new SyncError('SYNC_KEY is missing from the server’s .env, so the saved connection can’t be opened.', 503);
  const [v, iv, tag, body] = enc.split('.');
  if (v !== 'v1') throw new SyncError('Unknown connection format.');
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new SyncError('The saved connection can’t be opened with this SYNC_KEY. If the key changed, disconnect and connect again.', 503);
  }
}

const checkUrl = (u: string, allowHttp: boolean, what: string) => {
  let url: URL;
  try { url = new URL(u); } catch { throw new SyncError(`That ${what} isn’t valid.`); }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new SyncError(`That ${what} isn’t an https address.`);
  return url;
};

/** Exchange a one-time setup token (base64 of a claim URL) for the long-lived access URL. */
export async function claim(setupToken: string, allowHttp = false): Promise<string> {
  let claimUrl: string;
  try { claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim(); } catch { throw new SyncError('That doesn’t look like a SimpleFIN setup token.'); }
  if (!/^https?:\/\//.test(claimUrl)) throw new SyncError('That doesn’t look like a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.');
  checkUrl(claimUrl, allowHttp, 'setup token');
  let res: Response;
  try { res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, signal: AbortSignal.timeout(30000) }); }
  catch { throw new SyncError('Couldn’t reach SimpleFIN. Check the box’s internet connection and try again.', 502); }
  if (res.status === 403) throw new SyncError('SimpleFIN says that token was already used or has expired. Make a new setup token and paste it.');
  if (!res.ok) throw new SyncError(`SimpleFIN refused the token (${res.status}).`, 502);
  const access = (await res.text()).trim();
  const url = checkUrl(access, allowHttp, 'access address SimpleFIN returned');
  if (!url.username) throw new SyncError('SimpleFIN returned an access address without credentials.', 502);
  return access;
}

export interface SfAccount {
  id: string; name: string; currency?: string; balance?: string; 'balance-date'?: number;
  org?: { name?: string; domain?: string };
  transactions?: SfTransaction[];
}

/** Read accounts and transactions since `start` (epoch seconds), including pending ones. */
export async function fetchAccounts(access: string, start: number, allowHttp = false): Promise<{ errors: string[]; accounts: SfAccount[] }> {
  const url = checkUrl(access, allowHttp, 'access address');
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = ''; url.password = '';
  const base = url.toString().replace(/\/+$/, '');
  let res: Response;
  try { res = await fetch(`${base}/accounts?start-date=${Math.floor(start)}&pending=1`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60000) }); }
  catch { throw new SyncError('Couldn’t reach SimpleFIN. It will try again at the next sync.', 502); }
  if (res.status === 403) throw new SyncError('SimpleFIN refused the saved connection (it may have been revoked). Disconnect and connect again with a new setup token.', 502);
  if (!res.ok) throw new SyncError(`SimpleFIN answered ${res.status}. It will try again at the next sync.`, 502);
  const j = await res.json() as { errors?: string[]; accounts?: SfAccount[] };
  return { errors: Array.isArray(j.errors) ? j.errors.map(String) : [], accounts: Array.isArray(j.accounts) ? j.accounts : [] };
}

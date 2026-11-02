import type { BudgetStats, CategoryMemory, Month, MonthTotals } from '@optimystic/core';

export interface User { id: number; name: string; email: string; role: 'owner' | 'member' }
export interface MonthPayload {
  key: string;
  months: string[];
  month: Month;
  totals: MonthTotals;
  budget: BudgetStats;
  heloc: { thisMonth: number; io: number; repayPmt: number; shortfall: number };
  /** What each merchant was filed under before, across all months. */
  catMemory?: CategoryMemory;
  /** Card sync (SimpleFIN) at a glance. */
  sync?: { connected: boolean; lastSyncAt: string | null; lastError: string | null };
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message); }
}
/** The request never reached the server (offline, server down). */
export class NetworkError extends Error {}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new NetworkError('No connection.');
  }
  // tailscale serve / the service worker answer 502-504 when the box is unreachable
  if (res.status >= 502 && res.status <= 504) throw new NetworkError('The planner server isn’t answering.');
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, String(data.error || `Request failed (${res.status}).`), data);
  return data as T;
}

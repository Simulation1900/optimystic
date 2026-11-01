// Month keys are 'YYYY-MM'. All of this is plain arithmetic so it gives the same answer in any time zone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const isMonthKey = (k: unknown): k is string => typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);

const parts = (key: string): [number, number] => {
  const [y, m] = key.split('-').map(Number);
  return [y, m];
};

/** Months since year 0, for comparing and counting months. */
export const mIdx = (key: string): number => {
  const [y, m] = parts(key);
  return y * 12 + m - 1;
};

export const fromIdx = (i: number): string => {
  const y = Math.floor(i / 12), m = i - y * 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};

export const addMonths = (key: string, n: number): string => fromIdx(mIdx(key) + n);

export const daysIn = (key: string): number => {
  const [y, m] = parts(key);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const monthLabel = (key: string): string => {
  const [y, m] = parts(key);
  return `${MONTHS[m - 1]} ${y}`;
};

export const shortLabel = (key: string): string => {
  const [y, m] = parts(key);
  return `${MONTHS[m - 1].slice(0, 3)} ${y}`;
};

export const shortDate = (iso: string): string => {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}`;
};

export const monthBounds = (key: string) => ({ first: `${key}-01`, last: `${key}-${String(daysIn(key)).padStart(2, '0')}` });

/** Today in a given IANA time zone (the household's), as 'YYYY-MM-DD'. */
export const todayISO = (tz = 'America/Chicago', now = new Date()): string => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
export const todayKey = (tz?: string, now?: Date): string => todayISO(tz, now).slice(0, 7);

/** Share of a calendar month gone by: 1 for past months, 0 for future ones. */
export const monthPace = (key: string, today: string): number => {
  const t = today.slice(0, 7);
  if (key < t) return 1;
  if (key > t) return 0;
  return Number(today.slice(8, 10)) / daysIn(key);
};

export const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Money helpers, ported unchanged from the HTML planner so every figure matches it to the cent.

/** Parse what someone typed ("$1,234.5", " 12 ") into dollars rounded to the cent. Junk reads as 0. */
export const cents = (v: unknown): number =>
  Math.round((parseFloat(String(v ?? '').replace(/[$,\s]/g, '')) || 0) * 100) / 100;

/** Round to the cent. `+ 0` turns -0 into 0. */
export const r2 = (n: number): number => Math.round(n * 100) / 100 + 0;

/** Round up to the next cent (payments are never rounded down). */
export const ceil2 = (v: number): number => Math.ceil(r2(v * 100 * 100) / 100) / 100;

/** Sum the `amount` of a list in whole cents. */
export const sum = (list: ReadonlyArray<{ amount: number | string }>): number =>
  r2(list.reduce((t, b) => t + Math.round((Number(b.amount) || 0) * 100), 0) / 100);

/** Sum plain numbers in whole cents. */
export const sumOf = (list: ReadonlyArray<number>): number =>
  r2(list.reduce((t, v) => t + Math.round((Number(v) || 0) * 100), 0) / 100);

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const fmt = (n: number | string | null | undefined): string => usd.format(r2(Number(n) || 0) || 0);

export const num = (v: unknown): number => Number(v) || 0;

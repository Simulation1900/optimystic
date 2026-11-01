/** Short random ids, the same style the HTML planner used ('m2fxg8ew'). */
export const uid = (): string => {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint8Array(8);
    c.getRandomValues(a);
    return Array.from(a, x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  }
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
};

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

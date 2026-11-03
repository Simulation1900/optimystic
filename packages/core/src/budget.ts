import type { Budget, BudgetCategory, Month } from './types.js';
import { r2 } from './money.js';

/** Description patterns, checked in order; the first category that exists in the month wins. */
export const CAT_RULES: Array<[string, RegExp]> = [
  ['Subscriptions', /YOUTUBE|AMAZON PRIME|ANTHROPIC|KITTL|NETFLIX|SPOTIFY|HULU|DISNEY|LIVEKIT|APPLE\.COM\/BILL/],
  ['Amazon', /AMAZON|AMZN/],
  ['Gas', /KROGER FUEL|FUEL|MAPCO|SHELL|PILOT|BP#|EXXON|MARATHON|RACETRAC|LOVE.S|THORNTONS|CIRCLE ?K|SPEEDWAY|TIGERMARKET|MURPHY|CHEVRON|QUIKTRIP|COSTCO GAS/],
  ['Groceries', /KROGER|PUBLIX|WAL-?MART|WM SUPERCENTER|HEXT|TURNIP|SPROUTS|HG HILL|ALDI|COSTCO|SAM.?S CLUB|BARESOL|TRADER JOE|WHOLE FOODS|FOOD LION|DOLLAR TREE/],
  ['Kids activities', /KIDSTRONG|GYMBOREE|LITTLE GYM/],
  ['Coffee & snacks', /JUIC|COFFEE|MADTOWN|BAKED ON|BREAKTIME|JENI|STARBUCKS|DUNKIN|ICE CREAM|ARGUETA|IMLAY|BELMONT BEAR|LIEGE/],
  ['Supplements', /MOMENTOUS|MAKE IT HAPPEN|GNC|VITAMIN SHOPPE/],
  ['Clothes, kids & gifts', /NIKE|OLD NAVY|CHILDRENS ?PLACE|CARTER|EXPRESS#|VIVOBAREFOOT|CADEN LANE|LITTLE MANTA|ADE AND AYO|SHECURVE|DIYANU|BROWN BABY|GOOD KIIND|GIFTIFY|TARGET|GAP |H&M|ZARA/],
  ['Home & hardware', /LOWES|HOME DEPOT|ROOMS ?TO ?GO|IKEA|ACE HARDWARE|WAYFAIR|MATTRESS/],
  ['Health & pharmacy', /WALGREENS|CVS|DENTAL|PHARM|TRUFIT|URGENT|CLINIC/],
  ['Donations', /ACTBLUE|FND|DONAT|NMAAM|CHARIT/],
  ['Travel & big purchases', /PARKING|TOLL|SKYWAY|VONLANE|HOTEL|AIRBNB|AIRLINE|DELTA|SOUTHWEST|PMUSA|PMOD|SWEETWATER|PLEX|FOSI|REGAL|MALCO|MUSEUM|PLANETARIUM|ADLER|PULSEWORKS|OBAMA PRES|NAYAX|MILLENNIUM/],
  ['Dining out', /TST\*|SQ \*|GRILL|TACO|BURGER|DELI|BBQ|PIZZA|CAFE|RESTAURANT|FIVE GUYS|CHEESECAKE|HATTIE|SONGBIRD|DOUGH|NATHAN AND SONS|PEPPER POTT|CRAFT BEER|EMMY|CANTEEN|CHICK-FIL|MCDONALD|WENDY|SONIC/]
];

/**
 * Tidy a card description: BoA pads the store name, city and state into columns ("KROGER #884      NASHVILLE   TN"),
 * so keep what comes before the first wide gap (3+ spaces), then collapse any remaining runs of spaces.
 */
export function cleanDesc(desc: string): string {
  return String(desc || '').trim().split(/\s{3,}/)[0].replace(/\s+/g, ' ').trim();
}

/**
 * The merchant part of a card description, so one store matches across purchases:
 * "AMAZON MKTPL*5P5JM4NC2" → "AMAZON MKTPL", "KROGER #884" → "KROGER", "SHELL OIL 12826796000" → "SHELL OIL",
 * "72823 - MILLENNIUM PARK" → "MILLENNIUM PARK". Leading processor tags like "TST*" and "SQ *" are kept.
 */
export function merchantKey(desc: string): string {
  return cleanDesc(desc).toUpperCase()
    .replace(/\*\s*(?=[A-Z0-9]*\d)[A-Z0-9]{4,}\b/g, ' ')   // order ids after a * (must contain a digit)
    .replace(/#\s*\d+/g, ' ')                                // store numbers
    .replace(/\b\d{3,}\b/g, ' ')                              // long numbers anywhere
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–.,:;]+|[\s\-–.,:;*]+$/g, '')
    .trim();
}

/** What the household filed each merchant under, most recent choice winning. Keyed by merchantKey. */
export type CategoryMemory = Record<string, { catId: string; catName: string }>;

/**
 * Build the memory from expenses in the order they were filed (oldest first). Only categories a person
 * picked count (`catChosen`), not CSV guesses.
 */
export function learnCategories(rows: ReadonlyArray<{ desc: string; catId: string; catName: string; catChosen?: boolean }>): CategoryMemory {
  const mem: CategoryMemory = {};
  for (const r of rows) {
    if (r.catChosen === false || !r.catId) continue;
    const k = merchantKey(r.desc);
    if (k) mem[k] = { catId: r.catId, catName: r.catName };
  }
  return mem;
}

/** The category the memory remembers for a description, if that category exists in this month's budget. */
export function rememberedCat(desc: string, b: Budget, memory?: CategoryMemory): BudgetCategory | undefined {
  const hit = memory?.[merchantKey(desc)];
  if (!hit) return undefined;
  return b.cats.find(k => k.id === hit.catId) || b.cats.find(k => k.name.toLowerCase() === hit.catName.toLowerCase());
}

/**
 * Guess a category from a purchase description: what you filed this merchant under before, else the keyword
 * rules, else "Other", else the last category.
 */
export function guessCat(desc: string, b: Budget, memory?: CategoryMemory): BudgetCategory | undefined {
  const remembered = rememberedCat(desc, b, memory);
  if (remembered) return remembered;
  const u = String(desc || '').toUpperCase();
  for (const [name, rx] of CAT_RULES) {
    if (rx.test(u)) {
      const c = b.cats.find(k => k.name.toLowerCase() === name.toLowerCase());
      if (c) return c;
    }
  }
  return b.cats.find(k => k.name.toLowerCase() === 'other') || b.cats[b.cats.length - 1];
}

export interface CardStats { id: string; name: string; billName: string; color: string; spent: number; budget: number; projected: number }
export interface BudgetStats {
  byCat: Record<string, number>; byCard: Record<string, number>;
  spent: number; limit: number; left: number; cards: CardStats[]; projected: number; actual: number;
}

/**
 * Rule 11: a category's spent = its expenses (returns negative); a card's spent = the expenses placed on it.
 * Rule 10's projected card bill = spent + whatever is left in that card's categories.
 */
export function budgetStats(m: Month): BudgetStats {
  const b = m.budget, cents: Record<string, number> = {}, cardCents: Record<string, number> = {};
  let spent = 0;
  b.expenses.forEach(e => {
    const a = Math.round((Number(e.amount) || 0) * 100);
    cents[e.catId] = (cents[e.catId] || 0) + a;
    cardCents[e.cardId] = (cardCents[e.cardId] || 0) + a;
    spent += a;
  });
  const byCat: Record<string, number> = {}, byCard: Record<string, number> = {};
  Object.keys(cents).forEach(k => { byCat[k] = cents[k] / 100; });
  Object.keys(cardCents).forEach(k => { byCard[k] = cardCents[k] / 100; });
  const limit = r2(b.cats.reduce((t, k) => t + (Number(k.limit) || 0), 0));
  const cards = b.cards.map(c => {
    const mine = b.cats.filter(k => k.cardId === c.id);
    const budget = r2(mine.reduce((t, k) => t + (Number(k.limit) || 0), 0));
    const rest = mine.reduce((t, k) => t + Math.max(0, (Number(k.limit) || 0) - (byCat[k.id] || 0)), 0);
    const sp = r2(byCard[c.id] || 0);
    return { id: c.id, name: c.name, billName: c.billName, color: c.color, spent: sp, budget, projected: r2(sp + rest) };
  });
  return {
    byCat, byCard, spent: r2(spent / 100), limit, left: r2(limit - spent / 100), cards,
    projected: r2(cards.reduce((t, c) => t + c.projected, 0)), actual: r2(cards.reduce((t, c) => t + c.spent, 0))
  };
}

export interface OverBudget { catId: string; name: string; spent: number; limit: number; cardName: string }

/**
 * Categories that went over their limit between two versions of a month (spent was at or under the limit before,
 * over it after). Used for over-budget alerts, so a category alerts once when it crosses, not on every charge.
 */
export function newlyOverBudget(before: Month, after: Month): OverBudget[] {
  const b = budgetStats(before), a = budgetStats(after);
  return after.budget.cats.flatMap(k => {
    const lim = Number(k.limit) || 0, was = b.byCat[k.id] || 0, now = a.byCat[k.id] || 0;
    if (!(lim > 0) || !(now > lim + 0.004) || was > lim + 0.004) return [];
    return [{ catId: k.id, name: k.name, spent: r2(now), limit: lim, cardName: after.budget.cards.find(c => c.id === k.cardId)?.name || '' }];
  });
}

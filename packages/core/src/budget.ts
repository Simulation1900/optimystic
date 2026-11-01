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

/** Guess a category from a purchase description; falls back to "Other", then the last category. */
export function guessCat(desc: string, b: Budget): BudgetCategory | undefined {
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

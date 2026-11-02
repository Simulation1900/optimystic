// The shapes here match the HTML planner's saved state (and its JSON backups) field for field,
// so a backup can be loaded, worked on and exported again without translation.

/** Row bookkeeping the server adds. Never part of the planner math. */
export interface RowMeta {
  version?: number;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface Account extends RowMeta {
  id: string;
  name: string;
  balance: number;
  deposit?: number;
  color?: string;
}

export interface HelocApplied { interest: number; principal: number }
export interface LoanApplied { loanId: string; interest: number; principal: number; escrow: number }
/** Left by an older planner version that took paid bills out of account balances. */
export interface BalanceApplied { acctId: string; amount: number }

export interface Bill extends RowMeta {
  id: string;
  name: string;
  amount: number;
  accountId: string | null;
  recurring: boolean;
  dueDay: number | null;
  paid: boolean;
  helocApplied?: HelocApplied | null;
  loanApplied?: LoanApplied | null;
  balanceApplied?: BalanceApplied | null;
}

export type LoanKind = 'car' | 'home' | 'other';

export interface Loan extends RowMeta {
  id: string;
  kind: LoanKind;
  name: string;
  lender: string;
  balance: number;
  rate: number;
  payment: number;
  escrow: number;
  original: number;
  open: string;
  term: number;
  vin: string;
  purchasePrice: number;
  value: number;
  valueAsOf: string;
  valueRate: number;
  valueEstimated: boolean;
  billName: string;
  customPmt: number;
}

export interface HelocDraw extends RowMeta {
  id: string;
  acctId: string;
  amount: number;
}

export interface Heloc extends RowMeta {
  limit: number;
  rate: number;
  start: string;
  drawYears: number;
  repayYears: number;
  balance: number;
  available: number;
  ytdInterest: number;
  customPmt?: number;
  draws: HelocDraw[];
}

export interface BudgetCard extends RowMeta {
  id: string;
  name: string;
  billName: string;
  color: string;
}

export interface BudgetCategory extends RowMeta {
  id: string;
  name: string;
  limit: number;
  cardId: string;
}

export type ExpenseSource = 'manual' | 'csv' | 'sync';

export interface CardExpense extends RowMeta {
  id: string;
  date: string;
  desc: string;
  amount: number;
  catId: string;
  cardId: string;
  source?: ExpenseSource;
  /** True when a person picked (or kept) the category; CSV and sync guesses are false. Teaches the category memory. */
  catChosen?: boolean;
  /** The bank's transaction id, for charges brought in (or matched) by card sync. */
  externalId?: string;
}

export interface Budget {
  baseline: number;
  cards: BudgetCard[];
  cats: BudgetCategory[];
  expenses: CardExpense[];
}

/**
 * Money moved between two of the household's accounts this month. It counts against the "from" account's
 * left-after-bills and adds to the "to" account's; balances aren't touched (they come from the bank).
 * `done` is only a marker, like a paid bill.
 */
export interface Transfer extends RowMeta {
  id: string;
  fromId: string;
  toId: string;
  amount: number;
  note: string;
  recurring: boolean;
  done: boolean;
}

export interface Month {
  accounts: Account[];
  bills: Bill[];
  transfers: Transfer[];
  loans: Loan[];
  heloc: Heloc;
  budget: Budget;
  /** Month row bookkeeping (server only). */
  meta?: RowMeta;
}

/** The whole planner: what the HTML planner kept in localStorage and exports as a backup. */
export interface PlannerState {
  current: string;
  months: Record<string, Month>;
  tab?: string;
}

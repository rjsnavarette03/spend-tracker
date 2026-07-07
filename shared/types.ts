// Types shared between the React frontend and (conceptually) the PHP API.
// The PHP side mirrors these shapes exactly — keep them in sync.

export type TxType = 'income' | 'expense';

export interface User {
  id: number;
  email: string;
  name: string;
  hasPassword: boolean;
  hasGoogle: boolean;
  currency: string; // ISO 4217 code, e.g. 'USD', 'PHP'
  // False until the user confirms their email (via 6-digit code or backup
  // link). Data endpoints are blocked and the app shows the verify screen
  // until this is true. Google accounts and pre-existing accounts are verified.
  emailVerified: boolean;
}

export interface Category {
  id: number;
  name: string;
  type: TxType;
  color: string;
  txCount: number;
}

export type AccountType = 'debit' | 'credit' | 'loan';

// Balance semantics: positive = money you have, negative = money you owe.
// balanceCents = opening + income tx − expense tx − (transfers out + fees) + transfers in.
export interface Account {
  id: number;
  name: string;
  type: AccountType;
  color: string;
  // Optional custom image as a data URI. When set, the UI shows it instead of
  // the color; color is kept as the fallback (and identity color in compact
  // lists like transactions/transfers).
  image: string | null;
  openingBalanceCents: number;
  balanceCents: number;
  txCount: number;
  transferCount: number;
}

export interface Transfer {
  id: number;
  fromAccountId: number | null; // null after the account was deleted
  toAccountId: number | null;
  amountCents: number;
  feeCents: number;
  date: string; // YYYY-MM-DD
  note: string;
  fromName: string | null;
  fromColor: string | null;
  toName: string | null;
  toColor: string | null;
}

export interface TransferInput {
  fromAccountId: number;
  toAccountId: number;
  amountCents: number;
  feeCents: number;
  date: string; // YYYY-MM-DD
  note: string;
}

export interface Transaction {
  id: number;
  amountCents: number;
  type: TxType;
  categoryId: number | null;
  accountId: number | null;
  date: string; // YYYY-MM-DD
  note: string;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string | null;
  accountColor: string | null;
}

export interface TxInput {
  amountCents: number;
  type: TxType;
  categoryId: number | null;
  accountId: number | null;
  date: string; // YYYY-MM-DD
  note: string;
}

export interface TxFilter {
  month?: string; // YYYY-MM
  from?: string; // YYYY-MM-DD inclusive (date-range filter)
  to?: string; // YYYY-MM-DD inclusive
  type?: TxType | 'all';
  categoryId?: number | 'all';
  accountId?: number | 'all';
  search?: string;
}

// The recurring period a budget amount applies to.
export type BudgetCadence = 'week' | 'month' | 'year';

// One row per expense category (budget may be unset = amount 0). A category has
// at most one recurring budget. `spentCents` is the category's expense total in
// the current period of `cadence` (this week / this month / this year).
export interface Budget {
  id: number;
  categoryId: number;
  cadence: BudgetCadence;
  amountCents: number;
  categoryName: string;
  categoryColor: string;
  spentCents: number;
}

export interface MonthlySummary {
  month: string; // YYYY-MM
  incomeCents: number;
  expenseCents: number;
}

export interface BreakdownRow {
  categoryId: number | null;
  name: string;
  color: string;
  totalCents: number;
}

export interface AuthResponse {
  user: User;
  csrf: string;
}

export interface MeResponse {
  user: User | null;
  csrf: string;
  googleClientId: string;
}

export interface Api {
  auth: {
    me(): Promise<MeResponse>;
    register(email: string, password: string, name: string): Promise<AuthResponse>;
    login(email: string, password: string): Promise<AuthResponse>;
    google(credential: string): Promise<AuthResponse>;
    logout(): Promise<void>;
    forgot(email: string): Promise<void>;
    reset(token: string, password: string): Promise<AuthResponse>;
    // Email verification: `verify` submits the 6-digit code (signed-in user),
    // `verifyLink` redeems the emailed backup token (may be signed out — signs
    // the user in), `resendVerification` re-issues the code/link.
    verify(code: string): Promise<AuthResponse>;
    verifyLink(token: string): Promise<AuthResponse>;
    resendVerification(): Promise<void>;
    changePassword(currentPassword: string, newPassword: string): Promise<void>;
    setCurrency(currency: string): Promise<string>;
  };
  categories: {
    list(): Promise<Category[]>;
    create(data: { name: string; type: TxType; color: string }): Promise<Category>;
    update(id: number, data: { name: string; color: string }): Promise<void>;
    remove(id: number): Promise<void>;
  };
  accounts: {
    list(): Promise<Account[]>;
    create(data: {
      name: string;
      type: AccountType;
      color: string;
      image: string | null;
      openingBalanceCents: number;
    }): Promise<Account>;
    update(
      id: number,
      data: { name: string; color: string; image: string | null; openingBalanceCents: number }
    ): Promise<void>;
    remove(id: number): Promise<void>;
  };
  transfers: {
    list(month?: string): Promise<Transfer[]>;
    create(data: TransferInput): Promise<Transfer>;
    update(id: number, data: TransferInput): Promise<void>;
    remove(id: number): Promise<void>;
  };
  transactions: {
    list(filter: TxFilter): Promise<Transaction[]>;
    create(data: TxInput): Promise<Transaction>;
    update(id: number, data: TxInput): Promise<void>;
    remove(id: number): Promise<void>;
  };
  budgets: {
    list(): Promise<Budget[]>;
    upsert(categoryId: number, cadence: BudgetCadence, amountCents: number): Promise<void>;
  };
  reports: {
    summary(from: string, to: string): Promise<MonthlySummary>;
    trend(endMonth: string, count: number): Promise<MonthlySummary[]>;
    breakdown(from: string, to: string, type: TxType): Promise<BreakdownRow[]>;
    years(): Promise<number[]>;
  };
}

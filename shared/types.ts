// Types shared between the Electron main process and the React renderer.

export type TxType = 'income' | 'expense';

export interface Category {
  id: number;
  name: string;
  type: TxType;
  color: string;
  txCount: number;
}

export interface Transaction {
  id: number;
  amountCents: number;
  type: TxType;
  categoryId: number | null;
  date: string; // YYYY-MM-DD
  note: string;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface TxInput {
  amountCents: number;
  type: TxType;
  categoryId: number | null;
  date: string; // YYYY-MM-DD
  note: string;
}

export interface TxFilter {
  month?: string; // YYYY-MM
  type?: TxType | 'all';
  categoryId?: number | 'all';
  search?: string;
}

// One row per expense category for a given month (budget may be unset = 0).
export interface Budget {
  id: number; // budget row id, 0 when no budget set for the month
  categoryId: number;
  month: string; // YYYY-MM
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

export interface Api {
  categories: {
    list(): Promise<Category[]>;
    create(data: { name: string; type: TxType; color: string }): Promise<Category>;
    update(id: number, data: { name: string; color: string }): Promise<void>;
    remove(id: number): Promise<void>;
  };
  transactions: {
    list(filter: TxFilter): Promise<Transaction[]>;
    create(data: TxInput): Promise<Transaction>;
    update(id: number, data: TxInput): Promise<void>;
    remove(id: number): Promise<void>;
    exportCsv(filter: TxFilter): Promise<{ saved: boolean; path?: string }>;
  };
  budgets: {
    list(month: string): Promise<Budget[]>;
    upsert(categoryId: number, month: string, amountCents: number): Promise<void>;
    copyFromPrevious(month: string): Promise<number>;
  };
  reports: {
    summary(month: string): Promise<MonthlySummary>;
    trend(endMonth: string, count: number): Promise<MonthlySummary[]>;
    breakdown(month: string, type: TxType): Promise<BreakdownRow[]>;
  };
  app: {
    version(): Promise<string>;
    dbPath(): Promise<string>;
  };
}

import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BreakdownRow,
  Budget,
  Category,
  MonthlySummary,
  Transaction,
  TxFilter,
  TxInput,
  TxType,
} from '../shared/types';

let db: Database;
let dbFile: string;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  color TEXT NOT NULL DEFAULT '#6366f1'
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (category_id, month)
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
`;

const DEFAULT_CATEGORIES: Array<[string, TxType, string]> = [
  ['Salary', 'income', '#34d399'],
  ['Freelance', 'income', '#2dd4bf'],
  ['Investments', 'income', '#a78bfa'],
  ['Other Income', 'income', '#94a3b8'],
  ['Housing', 'expense', '#f97316'],
  ['Groceries', 'expense', '#84cc16'],
  ['Transport', 'expense', '#38bdf8'],
  ['Utilities', 'expense', '#eab308'],
  ['Dining Out', 'expense', '#fb7185'],
  ['Entertainment', 'expense', '#c084fc'],
  ['Health', 'expense', '#f43f5e'],
  ['Shopping', 'expense', '#f59e0b'],
  ['Subscriptions', 'expense', '#818cf8'],
  ['Other', 'expense', '#94a3b8'],
];

// ---------- lifecycle ----------

export async function initDb(userDataDir: string): Promise<void> {
  fs.mkdirSync(userDataDir, { recursive: true });
  dbFile = path.join(userDataDir, 'spend-tracker.sqlite');

  const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
  const wasmBinary = fs.readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary } as never);

  db = fs.existsSync(dbFile)
    ? new SQL.Database(fs.readFileSync(dbFile))
    : new SQL.Database();

  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  seedIfEmpty();
  persist();
}

export function getDbFilePath(): string {
  return dbFile;
}

function seedIfEmpty(): void {
  const count = scalar('SELECT COUNT(*) FROM categories');
  if (count > 0) return;
  for (const [name, type, color] of DEFAULT_CATEGORIES) {
    db.run('INSERT INTO categories (name, type, color) VALUES (?, ?, ?)', [name, type, color]);
  }
}

// Persist the whole DB to disk (write temp file, then atomic-ish rename).
// The dataset for a personal tracker is small, so a full export per
// mutation is cheap and guarantees nothing is lost on crash.
function persist(): void {
  const data = db.export();
  // sql.js export() closes and reopens the underlying connection, which
  // drops per-connection state: re-apply pragmas or FK actions stop working.
  db.run('PRAGMA foreign_keys = ON');
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, dbFile);
}

// ---------- query helpers ----------

type Row = Record<string, unknown>;

function all(sql: string, params: unknown[] = []): Row[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as never);
    const rows: Row[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as Row);
    return rows;
  } finally {
    stmt.free();
  }
}

// Runs a mutation and returns last_insert_rowid, which must be read
// BEFORE persist() — export() reopens the connection and resets it.
function run(sql: string, params: unknown[] = []): number {
  db.run(sql, params as never);
  const id = scalar('SELECT last_insert_rowid()');
  persist();
  return id;
}

function scalar(sql: string, params: unknown[] = []): number {
  const rows = all(sql, params);
  const first = rows[0] ? Object.values(rows[0])[0] : 0;
  return Number(first ?? 0);
}

// ---------- validation ----------

function assertMonth(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month: ${month}`);
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
}

function assertType(type: string): asserts type is TxType {
  if (type !== 'income' && type !== 'expense') throw new Error(`Invalid type: ${type}`);
}

function cleanName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('Name is required');
  if (n.length > 60) throw new Error('Name is too long (max 60 characters)');
  return n;
}

function cleanColor(color: string): string {
  const c = String(color ?? '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error(`Invalid color: ${c}`);
  return c;
}

function cleanAmount(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0 || cents > 1_000_000_000_00) {
    throw new Error('Amount must be a positive number');
  }
  return cents;
}

function cleanTxInput(data: TxInput): TxInput {
  assertType(data.type);
  assertDate(data.date);
  const categoryId = data.categoryId === null ? null : Number(data.categoryId);
  if (categoryId !== null && !Number.isInteger(categoryId)) throw new Error('Invalid category');
  return {
    amountCents: cleanAmount(data.amountCents),
    type: data.type,
    categoryId,
    date: data.date,
    note: String(data.note ?? '').slice(0, 500),
  };
}

// ---------- categories ----------

export function listCategories(): Category[] {
  return all(`
    SELECT c.id, c.name, c.type, c.color, COUNT(t.id) AS txCount
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
    GROUP BY c.id
    ORDER BY c.type, LOWER(c.name)
  `) as unknown as Category[];
}

export function createCategory(data: { name: string; type: TxType; color: string }): Category {
  assertType(data.type);
  const name = cleanName(data.name);
  const color = cleanColor(data.color);
  const id = run('INSERT INTO categories (name, type, color) VALUES (?, ?, ?)', [
    name,
    data.type,
    color,
  ]);
  return { id, name, type: data.type, color, txCount: 0 };
}

export function updateCategory(id: number, data: { name: string; color: string }): void {
  const name = cleanName(data.name);
  const color = cleanColor(data.color);
  run('UPDATE categories SET name = ?, color = ? WHERE id = ?', [name, color, id]);
}

export function deleteCategory(id: number): void {
  // FK actions: transactions.category_id -> NULL, budgets rows -> deleted.
  run('DELETE FROM categories WHERE id = ?', [id]);
}

// ---------- transactions ----------

function txWhere(filter: TxFilter): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.month) {
    assertMonth(filter.month);
    where.push("substr(t.date, 1, 7) = ?");
    params.push(filter.month);
  }
  if (filter.type && filter.type !== 'all') {
    assertType(filter.type);
    where.push('t.type = ?');
    params.push(filter.type);
  }
  if (typeof filter.categoryId === 'number') {
    where.push('t.category_id = ?');
    params.push(filter.categoryId);
  }
  if (filter.search && filter.search.trim()) {
    const s = `%${filter.search.trim().toLowerCase()}%`;
    where.push('(LOWER(t.note) LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ?)');
    params.push(s, s);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listTransactions(filter: TxFilter = {}): Transaction[] {
  const { clause, params } = txWhere(filter);
  return all(
    `
    SELECT t.id, t.amount_cents AS amountCents, t.type, t.category_id AS categoryId,
           t.date, t.note, c.name AS categoryName, c.color AS categoryColor
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    ${clause}
    ORDER BY t.date DESC, t.id DESC
  `,
    params
  ) as unknown as Transaction[];
}

export function createTransaction(data: TxInput): Transaction {
  const d = cleanTxInput(data);
  const id = run(
    'INSERT INTO transactions (amount_cents, type, category_id, date, note) VALUES (?, ?, ?, ?, ?)',
    [d.amountCents, d.type, d.categoryId, d.date, d.note]
  );
  return listTransactions({}).find((t) => t.id === id)!;
}

export function updateTransaction(id: number, data: TxInput): void {
  const d = cleanTxInput(data);
  run(
    'UPDATE transactions SET amount_cents = ?, type = ?, category_id = ?, date = ?, note = ? WHERE id = ?',
    [d.amountCents, d.type, d.categoryId, d.date, d.note, id]
  );
}

export function deleteTransaction(id: number): void {
  run('DELETE FROM transactions WHERE id = ?', [id]);
}

export function transactionsToCsv(filter: TxFilter = {}): string {
  const rows = listTransactions(filter);
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Date,Type,Category,Note,Amount'];
  for (const t of rows) {
    const amount = (t.amountCents / 100).toFixed(2);
    lines.push(
      [t.date, t.type, esc(t.categoryName ?? 'Uncategorized'), esc(t.note), amount].join(',')
    );
  }
  // UTF-8 BOM so Excel detects the encoding correctly.
  return '﻿' + lines.join('\r\n');
}

// ---------- budgets ----------

export function listBudgets(month: string): Budget[] {
  assertMonth(month);
  return all(
    `
    SELECT COALESCE(b.id, 0) AS id,
           c.id AS categoryId,
           ? AS month,
           COALESCE(b.amount_cents, 0) AS amountCents,
           c.name AS categoryName,
           c.color AS categoryColor,
           COALESCE((
             SELECT SUM(t.amount_cents) FROM transactions t
             WHERE t.category_id = c.id AND t.type = 'expense' AND substr(t.date, 1, 7) = ?
           ), 0) AS spentCents
    FROM categories c
    LEFT JOIN budgets b ON b.category_id = c.id AND b.month = ?
    WHERE c.type = 'expense'
    ORDER BY LOWER(c.name)
  `,
    [month, month, month]
  ) as unknown as Budget[];
}

export function upsertBudget(categoryId: number, month: string, amountCents: number): void {
  assertMonth(month);
  if (!Number.isInteger(categoryId)) throw new Error('Invalid category');
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('Invalid amount');
  if (amountCents === 0) {
    run('DELETE FROM budgets WHERE category_id = ? AND month = ?', [categoryId, month]);
    return;
  }
  run(
    `INSERT INTO budgets (category_id, month, amount_cents) VALUES (?, ?, ?)
     ON CONFLICT (category_id, month) DO UPDATE SET amount_cents = excluded.amount_cents`,
    [categoryId, month, amountCents]
  );
}

export function copyBudgetsFromPrevious(month: string): number {
  assertMonth(month);
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  db.run(
    `INSERT INTO budgets (category_id, month, amount_cents)
     SELECT category_id, ?, amount_cents FROM budgets WHERE month = ?
     ON CONFLICT (category_id, month) DO NOTHING`,
    [month, prevMonth]
  );
  const copied = db.getRowsModified();
  persist();
  return copied;
}

// ---------- reports ----------

export function getSummary(month: string): MonthlySummary {
  assertMonth(month);
  const rows = all(
    `SELECT type, SUM(amount_cents) AS total FROM transactions
     WHERE substr(date, 1, 7) = ? GROUP BY type`,
    [month]
  );
  const summary: MonthlySummary = { month, incomeCents: 0, expenseCents: 0 };
  for (const r of rows) {
    if (r.type === 'income') summary.incomeCents = Number(r.total);
    if (r.type === 'expense') summary.expenseCents = Number(r.total);
  }
  return summary;
}

export function getTrend(endMonth: string, count: number): MonthlySummary[] {
  assertMonth(endMonth);
  const n = Math.min(Math.max(Number(count) || 6, 1), 24);
  const [y, m] = endMonth.split('-').map(Number);
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const placeholders = months.map(() => '?').join(',');
  const rows = all(
    `SELECT substr(date, 1, 7) AS month, type, SUM(amount_cents) AS total
     FROM transactions
     WHERE substr(date, 1, 7) IN (${placeholders})
     GROUP BY month, type`,
    months
  );
  const map = new Map<string, MonthlySummary>(
    months.map((mo) => [mo, { month: mo, incomeCents: 0, expenseCents: 0 }])
  );
  for (const r of rows) {
    const entry = map.get(String(r.month));
    if (!entry) continue;
    if (r.type === 'income') entry.incomeCents = Number(r.total);
    if (r.type === 'expense') entry.expenseCents = Number(r.total);
  }
  return months.map((mo) => map.get(mo)!);
}

export function getBreakdown(month: string, type: TxType): BreakdownRow[] {
  assertMonth(month);
  assertType(type);
  return all(
    `
    SELECT t.category_id AS categoryId,
           COALESCE(c.name, 'Uncategorized') AS name,
           COALESCE(c.color, '#64748b') AS color,
           SUM(t.amount_cents) AS totalCents
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE substr(t.date, 1, 7) = ? AND t.type = ?
    GROUP BY t.category_id
    ORDER BY totalCents DESC
  `,
    [month, type]
  ) as unknown as BreakdownRow[];
}

// Reading a bank statement exported as CSV, for the import screen
// (src/components/ImportModal.tsx): parse the file, guess which column is
// which, turn each line into a transaction to review, apply the user's
// "description contains" rules and spot lines that are already recorded.
// Pure functions with no I/O; tests in src/csvImport.test.ts.
import type { ImportRule, Transaction, TxType } from '../shared/types';

// ---------- the file ----------

/** The separator used most, outside quotes, on the file's first lines. */
function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 10);
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    let count = 0;
    for (const line of lines) {
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) count++;
      }
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Rows of trimmed cells. Handles quoted cells (with separators, line breaks
 * and doubled "" inside), CRLF or LF line ends, a leading BOM, and comma,
 * semicolon or tab separators. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// ---------- cells ----------

/**
 * A money cell as signed cents, or null when it isn't an amount. Reads
 * "₱1,234.56", "PHP 50", "-50", "50-", "(1,234.56)" (negative), "1,234.56 DR"
 * (negative), "... CR" (positive), and a decimal comma ("12,50", "1.234,56").
 */
export function parseAmount(value: string): number | null {
  let s = value.trim().toUpperCase();
  if (s === '' || /[/:]/.test(s)) return null; // dates and times aren't amounts
  let sign = 1;
  const marker = s.match(/\s*(DR|CR)\.?$/);
  if (marker) {
    if (marker[1] === 'DR') sign = -1;
    s = s.slice(0, marker.index);
  }
  // A currency code or symbol is fine; words mean this is some other column.
  if ((s.match(/[A-Z]/g) ?? []).length > 3) return null;
  s = s.replace(/[^0-9.,()-]/g, '');
  if (/^\(.*\)$/.test(s)) {
    sign = -sign;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    sign = -sign;
    s = s.slice(0, -1);
  }
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let plain: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Whichever comes last is the decimal point.
    plain = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    // "12,50" is a decimal comma; "1,234" and "1,234,567" are thousands.
    plain = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else {
    plain = s;
  }
  if ((plain.match(/\./g) ?? []).length > 1) return null;
  const n = Number(plain);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return cents === 0 ? 0 : sign * cents;
}

export type DateFormat = 'ymd' | 'mdy' | 'dmy' | 'text';

export const DATE_FORMAT_LABEL: Record<DateFormat, string> = {
  ymd: 'Year-month-day (2026-11-14)',
  mdy: 'Month/day/year (11/14/2026)',
  dmy: 'Day/month/year (14/11/2026)',
  text: 'Written month (Nov 14, 2026)',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date cell in `format` as YYYY-MM-DD, or null when it doesn't fit or isn't a real date. A time after it is ignored. */
export function parseDate(value: string, format: DateFormat): string | null {
  const s = value.trim();
  let y: number;
  let m: number;
  let d: number;
  if (format === 'text') {
    // "Nov 14, 2026", "November 14 2026", "14 Nov 2026", "14-Nov-26"
    const monthFirst = s.match(/^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{2}|\d{4})\b/);
    const dayFirst = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})\b/);
    if (monthFirst) {
      m = MONTHS.indexOf(monthFirst[1].slice(0, 3).toLowerCase()) + 1;
      d = Number(monthFirst[2]);
      y = Number(monthFirst[3]);
    } else if (dayFirst) {
      d = Number(dayFirst[1]);
      m = MONTHS.indexOf(dayFirst[2].slice(0, 3).toLowerCase()) + 1;
      y = Number(dayFirst[3]);
    } else {
      return null;
    }
  } else {
    const p = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})\b/);
    if (!p) return null;
    if (format === 'ymd') {
      if (p[1].length !== 4) return null;
      [y, m, d] = [Number(p[1]), Number(p[2]), Number(p[3])];
    } else {
      if (p[3].length !== 2 && p[3].length !== 4) return null;
      [m, d] = format === 'mdy' ? [Number(p[1]), Number(p[2])] : [Number(p[2]), Number(p[1])];
      y = Number(p[3]);
    }
  }
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > new Date(y, m, 0).getDate()) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const FORMATS: DateFormat[] = ['ymd', 'text', 'mdy', 'dmy'];

function isAnyDate(value: string): boolean {
  return FORMATS.some((f) => parseDate(value, f) !== null);
}

/**
 * The format that reads the most of these cells. On a tie (every day is 12
 * or less, so 03/04 could be either) month-first wins; the user can switch.
 */
export function detectDateFormat(values: string[]): DateFormat | null {
  const sample = values.map((v) => v.trim()).filter((v) => v !== '').slice(0, 300);
  let best: DateFormat | null = null;
  let bestCount = 0;
  for (const f of FORMATS) {
    const count = sample.filter((v) => parseDate(v, f) !== null).length;
    if (count > bestCount) {
      best = f;
      bestCount = count;
    }
  }
  return best;
}

// ---------- columns ----------

export interface ColumnMap {
  date: number; // column index; -1 = none
  description: number;
  // 'signed': one amount column; 'split': money out and money in in separate columns.
  mode: 'signed' | 'split';
  amount: number;
  debit: number; // money out
  credit: number; // money in
  outIsNegative: boolean; // signed mode: a money-out line has a negative amount
}

/**
 * Which row holds the column names: the first of the first 20 rows with the
 * most filled cells (exports often open with a few lines about the account).
 * -1 when that row is already a statement line (it has a date and an amount).
 */
export function findHeaderRow(table: string[][]): number {
  const head = table.slice(0, 20);
  const filled = (r: string[]) => r.filter((c) => c !== '').length;
  const most = Math.max(0, ...head.map(filled));
  const i = head.findIndex((r) => filled(r) === most);
  if (i < 0) return -1;
  const row = head[i];
  const isLine = row.some(isAnyDate) && row.some((c) => !isAnyDate(c) && parseAmount(c) !== null);
  return isLine ? -1 : i;
}

/** Share of a column's filled cells that pass `test` (0 when it's empty). */
function share(rows: string[][], col: number, test: (v: string) => boolean): number {
  const cells = rows.map((r) => r[col] ?? '').filter((v) => v !== '');
  return cells.length === 0 ? 0 : cells.filter(test).length / cells.length;
}

/**
 * A first guess at the column map, from the column names when there are
 * some, else from what the cells look like. Money out is negative on bank
 * statements and positive on most card statements, hence `accountType`.
 */
export function guessColumns(headers: string[], rows: string[][], accountType: 'debit' | 'credit'): ColumnMap {
  const names = headers.map((h) => h.toLowerCase());
  const taken = new Set<number>();
  const byName = (re: RegExp, exclude?: RegExp) => {
    const i = names.findIndex((n, j) => !taken.has(j) && re.test(n) && !(exclude && exclude.test(n)));
    if (i >= 0) taken.add(i);
    return i;
  };
  const width = Math.max(headers.length, ...rows.slice(0, 50).map((r) => r.length));
  const columns = Array.from({ length: width }, (_, j) => j);

  let date = byName(/trans(action)?\s*date|txn\s*date/);
  if (date < 0) date = byName(/date|posted|posting/);
  if (date < 0) {
    date = columns.find((j) => share(rows, j, isAnyDate) >= 0.6) ?? -1;
    if (date >= 0) taken.add(date);
  }

  const balance = /balance|running|available/;
  const debit = byName(/debit|withdraw|money out|paid out|outflow|spent|charge/, balance);
  const credit = byName(/credit|deposit|money in|paid in|inflow|received/, balance);
  const split = debit >= 0 && credit >= 0;
  let amount = split ? -1 : byName(/amount|amt|value|php|peso/, balance);
  if (!split && amount < 0) {
    amount = columns.find((j) => !taken.has(j) && !balance.test(names[j] ?? '') && share(rows, j, (v) => parseAmount(v) !== null) >= 0.6) ?? -1;
    if (amount >= 0) taken.add(amount);
  }

  let description = byName(/desc|detail|particular|narrat|merchant|payee|memo/);
  if (description < 0) description = byName(/remark|note|reference|ref\b|transaction/);
  if (description < 0) {
    // The free-text column: the longest cells among the rest.
    const avg = (j: number) => rows.slice(0, 50).reduce((s, r) => s + (r[j] ?? '').length, 0);
    description = columns.filter((j) => !taken.has(j)).sort((a, b) => avg(b) - avg(a))[0] ?? -1;
  }

  return {
    date,
    description,
    mode: split ? 'split' : 'signed',
    amount,
    debit: split ? debit : -1,
    credit: split ? credit : -1,
    outIsNegative: accountType === 'debit',
  };
}

// ---------- lines ----------

export interface StatementRow {
  line: number; // 1-based line in the file
  date: string | null;
  description: string;
  amountCents: number; // > 0 when readable
  type: TxType | null; // expense = money out, income = money in
  error: string | null; // why this line can't be imported
}

/** Each data row as a transaction to review. `firstLine` is the file line of rows[0]. */
export function buildRows(rows: string[][], firstLine: number, map: ColumnMap, dateFormat: DateFormat): StatementRow[] {
  return rows.map((r, i) => {
    const line = firstLine + i;
    const cell = (j: number) => (j >= 0 ? r[j] ?? '' : '');
    const description = cell(map.description).replace(/\s+/g, ' ').trim().slice(0, 500);
    const date = parseDate(cell(map.date), dateFormat);
    let amountCents = 0;
    let type: TxType | null = null;
    let error: string | null = null;
    if (map.mode === 'signed') {
      const v = parseAmount(cell(map.amount));
      if (v === null || v === 0) {
        error = 'No amount';
      } else {
        amountCents = Math.abs(v);
        type = (v < 0) === map.outIsNegative ? 'expense' : 'income';
      }
    } else {
      const out = parseAmount(cell(map.debit));
      const inn = parseAmount(cell(map.credit));
      if (out && inn) error = 'Has both money out and money in';
      else if (out) [amountCents, type] = [Math.abs(out), 'expense'];
      else if (inn) [amountCents, type] = [Math.abs(inn), 'income'];
      else error = 'No amount';
    }
    if (date === null) error = cell(map.date) ? `Can't read the date "${cell(map.date)}"` : 'No date';
    return { line, date, description, amountCents, type: error ? null : type, error };
  });
}

// ---------- rules and duplicates ----------

/** The rule for a line: the longest keyword its description contains, among rules for its type. */
export function matchRule(description: string, type: TxType, rules: ImportRule[]): ImportRule | undefined {
  const text = description.toLowerCase();
  return rules
    .filter((r) => r.categoryType === type && text.includes(r.keyword))
    .sort((a, b) => b.keyword.length - a.keyword.length || a.keyword.localeCompare(b.keyword))[0];
}

/**
 * A keyword to suggest for a new rule: the description's first word, or its
 * first two when the first is short (like "SM"), without reference numbers.
 */
export function suggestKeyword(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9&'\s.-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !/\d{3,}/.test(w) && !/^[.-]+$/.test(w));
  if (words.length === 0) return '';
  return (words[0].length >= 4 || words.length === 1 ? words[0] : `${words[0]} ${words[1]}`).slice(0, 60);
}

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/**
 * Which statement lines look already recorded on the account: same type and
 * amount, dated the same day or up to `toleranceDays` apart (banks often post
 * a day or two after the purchase), the closest first. A recorded transaction
 * accounts for one line at most, and a split receipt counts as its total.
 * Returns row index → the matching transaction.
 */
export function findDuplicates(rows: StatementRow[], existing: Transaction[], toleranceDays = 3): Map<number, Transaction> {
  const groups = new Map<number, Transaction>();
  const candidates: Transaction[] = [];
  for (const t of existing) {
    if (t.splitGroup === null) {
      candidates.push(t);
      continue;
    }
    const g = groups.get(t.splitGroup);
    if (g) g.amountCents += t.amountCents;
    else groups.set(t.splitGroup, { ...t });
  }
  candidates.push(...groups.values());

  const used = new Set<Transaction>();
  const found = new Map<number, Transaction>();
  // Exact dates claim first, so a near match can't take an exact one's place.
  for (const maxGap of [0, toleranceDays]) {
    rows.forEach((r, i) => {
      if (found.has(i) || r.error || r.date === null || r.type === null) return;
      let best: Transaction | undefined;
      let bestGap = Infinity;
      for (const t of candidates) {
        if (used.has(t) || t.type !== r.type || t.amountCents !== r.amountCents) continue;
        const gap = Math.abs(dayNumber(t.date) - dayNumber(r.date));
        if (gap <= maxGap && gap < bestGap) {
          best = t;
          bestGap = gap;
        }
      }
      if (best) {
        used.add(best);
        found.set(i, best);
      }
    });
  }
  return found;
}

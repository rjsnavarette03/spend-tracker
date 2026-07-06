import type { Transaction } from '../shared/types';

// Active currency for money formatting. Set once from the signed-in user's
// preference (see api.ts, which calls setCurrency on every auth response), so
// the pure fmt* helpers stay call-site simple. Mirrors the CSRF-token pattern.
let currencyCode = 'USD';
let money = buildFormatter(currencyCode);

function buildFormatter(code: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
  } catch {
    // Unknown/invalid code — fall back so the UI never crashes.
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  }
}

export function setCurrency(code: string): void {
  const next = (code || 'USD').toUpperCase();
  if (next === currencyCode) return;
  currencyCode = next;
  money = buildFormatter(next);
}

export function getCurrency(): string {
  return currencyCode;
}

/** The active currency's symbol (e.g. "$", "₱", "RM"), for input prefixes. */
export function currencySymbol(): string {
  try {
    const parts = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    }).formatToParts(1);
    return parts.find((p) => p.type === 'currency')?.value ?? currencyCode;
  } catch {
    return currencyCode;
  }
}

/**
 * Reduce raw field input to a clean numeric string: digits, at most one dot,
 * at most two decimals, optional leading "-" when allowNegative. No grouping.
 * A lone "-" is preserved so a negative value can still be typed.
 */
export function sanitizeAmountInput(raw: string, allowNegative = false): string {
  const neg = allowNegative && raw.trim().startsWith('-');
  let s = raw.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) {
    s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  }
  let [int, dec] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  let clean: string;
  if (s.includes('.')) {
    clean = (int === '' ? '0' : int) + '.' + (dec ?? '').slice(0, 2);
  } else {
    clean = int;
  }
  if (neg) return clean === '' ? '-' : '-' + clean;
  return clean;
}

/** Format a clean numeric string for display with grouped thousands. */
export function formatAmountDisplay(clean: string): string {
  if (clean === '') return '';
  const neg = clean.startsWith('-');
  const body = neg ? clean.slice(1) : clean;
  if (body === '') return neg ? '-' : '';
  const hasDot = body.includes('.');
  let [int, dec] = body.split('.');
  int = int === '' ? '0' : int;
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = hasDot ? `${grouped}.${dec ?? ''}` : grouped;
  return (neg ? '-' : '') + out;
}

export function fmtMoney(cents: number): string {
  return money.format(cents / 100);
}

export function fmtSigned(cents: number, type: 'income' | 'expense'): string {
  return `${type === 'income' ? '+' : '−'}${money.format(cents / 100)}`;
}

/** "1,234.56", "$12", "9.5" -> cents; null when not a positive amount. */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const val = Number(cleaned);
  if (!Number.isFinite(val) || val <= 0) return null;
  // Guard sub-cent input like "0.004": it rounds to 0, which is not a positive
  // amount. Returning 0 here would slip past callers' `=== null` checks and,
  // for budgets, silently delete the row (0 = delete).
  const cents = Math.round(val * 100);
  return cents > 0 ? cents : null;
}

export function centsToInput(cents: number): string {
  return cents ? (cents / 100).toFixed(2) : '';
}

/**
 * Like parseAmountToCents but allows negative and zero values — used for
 * account starting balances, where negative means money owed. Empty input
 * counts as 0; null means "not a number".
 */
export function parseSignedAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const val = Number(cleaned);
  if (!Number.isFinite(val)) return null;
  return Math.round(val * 100);
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function shortMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function cleanError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build an Excel-friendly CSV (UTF-8 BOM, CRLF) from transactions. */
export function transactionsToCsv(rows: Transaction[]): string {
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Date,Type,Category,Account,Note,Amount'];
  for (const t of rows) {
    lines.push(
      [
        t.date,
        t.type,
        esc(t.categoryName ?? 'Uncategorized'),
        esc(t.accountName ?? ''),
        esc(t.note),
        (t.amountCents / 100).toFixed(2),
      ].join(',')
    );
  }
  return '﻿' + lines.join('\r\n');
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

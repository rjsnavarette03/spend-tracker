import type { BudgetCadence, Transaction } from '../shared/types';

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

// ---------- region-default currency (new signups) ----------

// Currency by home country, limited to the codes offered in Settings so a
// detected default is always a first-class dropdown choice.
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', PH: 'PHP', GB: 'GBP', JP: 'JPY', AU: 'AUD', CA: 'CAD',
  SG: 'SGD', HK: 'HKD', IN: 'INR', CN: 'CNY', MY: 'MYR', TH: 'THB',
  ID: 'IDR', VN: 'VND', KR: 'KRW', AE: 'AED', NZ: 'NZD', CH: 'CHF', TW: 'TWD',
  // euro area
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR',
  FI: 'EUR', FR: 'EUR', GR: 'EUR', HR: 'EUR', IE: 'EUR', IT: 'EUR',
  LT: 'EUR', LU: 'EUR', LV: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR',
  SI: 'EUR', SK: 'EUR',
};

// Primary IANA zones per supported currency. Checked BEFORE the browser
// locale: locales often stay factory-set to en-US (very common in PH), while
// the device timezone tracks where the user actually lives.
const TZ_CURRENCY: Record<string, string> = {
  'Asia/Manila': 'PHP',
  'Europe/London': 'GBP',
  'Asia/Tokyo': 'JPY',
  'Asia/Singapore': 'SGD',
  'Asia/Hong_Kong': 'HKD',
  'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR',
  'Asia/Shanghai': 'CNY', 'Asia/Urumqi': 'CNY',
  'Asia/Kuala_Lumpur': 'MYR', 'Asia/Kuching': 'MYR',
  'Asia/Bangkok': 'THB',
  'Asia/Jakarta': 'IDR', 'Asia/Pontianak': 'IDR', 'Asia/Makassar': 'IDR', 'Asia/Jayapura': 'IDR',
  'Asia/Ho_Chi_Minh': 'VND', 'Asia/Saigon': 'VND',
  'Asia/Seoul': 'KRW',
  'Asia/Dubai': 'AED',
  'Pacific/Auckland': 'NZD', 'Pacific/Chatham': 'NZD',
  'Europe/Zurich': 'CHF',
  'Asia/Taipei': 'TWD',
  // Australia
  'Australia/Sydney': 'AUD', 'Australia/Melbourne': 'AUD', 'Australia/Brisbane': 'AUD',
  'Australia/Perth': 'AUD', 'Australia/Adelaide': 'AUD', 'Australia/Darwin': 'AUD',
  'Australia/Hobart': 'AUD', 'Australia/Broken_Hill': 'AUD', 'Australia/Lord_Howe': 'AUD',
  // United States (America/* can't be prefix-matched — the Americas span
  // many currencies — so US/CA zones are listed explicitly)
  'America/New_York': 'USD', 'America/Detroit': 'USD', 'America/Chicago': 'USD',
  'America/Denver': 'USD', 'America/Phoenix': 'USD', 'America/Boise': 'USD',
  'America/Los_Angeles': 'USD', 'America/Anchorage': 'USD', 'Pacific/Honolulu': 'USD',
  // Canada
  'America/St_Johns': 'CAD', 'America/Halifax': 'CAD', 'America/Moncton': 'CAD',
  'America/Toronto': 'CAD', 'America/Winnipeg': 'CAD', 'America/Regina': 'CAD',
  'America/Edmonton': 'CAD', 'America/Vancouver': 'CAD',
  // euro area (major zones)
  'Europe/Paris': 'EUR', 'Europe/Berlin': 'EUR', 'Europe/Madrid': 'EUR',
  'Europe/Rome': 'EUR', 'Europe/Amsterdam': 'EUR', 'Europe/Brussels': 'EUR',
  'Europe/Vienna': 'EUR', 'Europe/Dublin': 'EUR', 'Europe/Lisbon': 'EUR',
  'Europe/Helsinki': 'EUR', 'Europe/Athens': 'EUR', 'Europe/Luxembourg': 'EUR',
  'Europe/Ljubljana': 'EUR', 'Europe/Bratislava': 'EUR', 'Europe/Vilnius': 'EUR',
  'Europe/Riga': 'EUR', 'Europe/Tallinn': 'EUR', 'Europe/Malta': 'EUR',
  'Europe/Zagreb': 'EUR', 'Asia/Nicosia': 'EUR',
};

/**
 * Best-guess default currency for a NEW account, from the browser's region:
 * device timezone first, then any explicit region subtag in the language
 * list (en-PH → PH), else USD. Sent as a hint with register/Google sign-in;
 * the server falls back to USD on anything unrecognized, and the user can
 * change it in Settings at any time.
 */
export function detectDefaultCurrency(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TZ_CURRENCY[tz]) return TZ_CURRENCY[tz];
    for (const lang of navigator.languages ?? []) {
      // Guard per entry: one malformed tag must not skip later valid ones.
      try {
        const region = new Intl.Locale(lang).region;
        if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
      } catch {
        /* non-BCP-47 tag — try the next one */
      }
    }
  } catch {
    /* Intl quirks — fall through to USD */
  }
  return 'USD';
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

// ---------- periods (day / week / month / year) ----------

export type Granularity = 'day' | 'week' | 'month' | 'year';

export interface Period {
  granularity: Granularity;
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The period of the given granularity that contains the local date `ref`. */
export function periodOf(granularity: Granularity, ref: Date): Period {
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const d = ref.getDate();
  if (granularity === 'day') {
    const s = ymd(new Date(y, m, d));
    return { granularity, start: s, end: s };
  }
  if (granularity === 'week') {
    const dow = ref.getDay(); // 0 = Sunday
    return {
      granularity,
      start: ymd(new Date(y, m, d - dow)),
      end: ymd(new Date(y, m, d - dow + 6)),
    };
  }
  if (granularity === 'month') {
    return { granularity, start: ymd(new Date(y, m, 1)), end: ymd(new Date(y, m + 1, 0)) };
  }
  return { granularity, start: ymd(new Date(y, 0, 1)), end: ymd(new Date(y, 11, 31)) };
}

export function currentPeriod(granularity: Granularity = 'month'): Period {
  return periodOf(granularity, new Date());
}

/** Move a period by ±1 unit of its own granularity. */
export function shiftPeriod(p: Period, delta: number): Period {
  const [y, m, d] = p.start.split('-').map(Number);
  switch (p.granularity) {
    case 'day':
      return periodOf('day', new Date(y, m - 1, d + delta));
    case 'week':
      return periodOf('week', new Date(y, m - 1, d + delta * 7));
    case 'month':
      return periodOf('month', new Date(y, m - 1 + delta, 1));
    default:
      return periodOf('year', new Date(y + delta, 0, 1));
  }
}

/** Switch granularity, keeping today if the current period contains it. */
export function changeGranularity(p: Period, granularity: Granularity): Period {
  const today = todayStr();
  const anchor = p.start <= today && today <= p.end ? today : p.start;
  const [y, m, d] = anchor.split('-').map(Number);
  return periodOf(granularity, new Date(y, m - 1, d));
}

export function periodLabel(p: Period): string {
  const [sy, sm, sd] = p.start.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  if (p.granularity === 'day') {
    return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (p.granularity === 'month') {
    return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  if (p.granularity === 'year') {
    return String(sy);
  }
  const [ey, em, ed] = p.end.split('-').map(Number);
  const end = new Date(ey, em - 1, ed);
  const startStr = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sy === ey ? {} : { year: 'numeric' }),
  });
  const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

// ---------- budget cadence ----------

/** Dropdown labels for the cadence selector. */
export const CADENCE_LABEL: Record<BudgetCadence, string> = {
  week: 'Weekly',
  month: 'Monthly',
  year: 'Yearly',
};

/** Compact suffix tag next to a budget amount, e.g. "$500/mo". */
export const CADENCE_SHORT: Record<BudgetCadence, string> = {
  week: '/wk',
  month: '/mo',
  year: '/yr',
};

/** How the "spent" window reads for a cadence (spend is scoped to it). */
export const CADENCE_PERIOD: Record<BudgetCadence, string> = {
  week: 'this week',
  month: 'this month',
  year: 'this year',
};

export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * Next occurrence among one or two monthly payment due days (credit/loan
 * accounts; two days = twice-a-month plans like the 15th + 30th). Today
 * counts as due; days 29–31 clamp to the last day of shorter months (a "due
 * on the 31st" card is due Feb 28). Because only days-of-month are stored,
 * the computed date always self-advances after each cycle.
 */
export function nextDueInfo(dueDay: number, dueDay2?: number | null): { days: number; label: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const nextFor = (day: number): Date => {
    const clamped = (y: number, m: number) => Math.min(day, new Date(y, m + 1, 0).getDate());
    let due = new Date(today.getFullYear(), today.getMonth(), clamped(today.getFullYear(), today.getMonth()));
    if (due < today) {
      const y = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
      const m = (today.getMonth() + 1) % 12;
      due = new Date(y, m, clamped(y, m));
    }
    return due;
  };

  const candidates = [dueDay, ...(dueDay2 != null ? [dueDay2] : [])].map(nextFor);
  const due = candidates.reduce((a, b) => (b < a ? b : a));
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  const label =
    days === 0
      ? 'Due today'
      : days === 1
        ? 'Due tomorrow'
        : 'Due ' + due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { days, label };
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

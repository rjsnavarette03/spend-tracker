// Pure date math for the Schedule page: when each payday lands (after the
// weekend rule) and whether its salary was received, and when each scheduled
// item falls due and which payday funds it. Dates are local 'YYYY-MM-DD'
// strings throughout, like the rest of the app.
//
// An occurrence is keyed by its NOMINAL date (the 8th, clamped to short
// months) — that's the dueDate stored on SchedulePayment links — so changing
// a payday's weekend rule never orphans what was already logged. `date` is
// when the money is actually expected.
import type {
  Account,
  ScheduleActivity,
  ScheduleData,
  ScheduleItem,
  ScheduleItemInput,
  ScheduleKind,
  SchedulePayment,
  Subscription,
  WeekendShift,
} from '../shared/types';

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  return toYmd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}

/** Day `day` of month m0 (0-based) in year y, clamped to the month's length (31st → Feb 28). */
export function clampedDate(y: number, m0: number, day: number): string {
  const last = new Date(y, m0 + 1, 0).getDate();
  return toYmd(new Date(y, m0, Math.min(day, last)));
}

/** A Saturday/Sunday date moved to the Friday before or the Monday after. */
export function shiftForWeekend(s: string, rule: WeekendShift): string {
  if (rule === 'none') return s;
  const dow = parseYmd(s).getDay();
  if (dow === 6) return addDays(s, rule === 'before' ? -1 : 2);
  if (dow === 0) return addDays(s, rule === 'before' ? -2 : 1);
  return s;
}

/** 'Fri, Nov 7' */
export function shortDateLabel(s: string): string {
  return parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export const WEEKEND_RULE_LABEL: Record<WeekendShift, string> = {
  before: 'Friday before',
  after: 'Monday after',
  none: 'Same day',
};

export function occurrenceKey(itemId: number, dueDate: string): string {
  return `${itemId}|${dueDate}`;
}

export interface PaydayOccurrence {
  item: ScheduleItem;
  dueDate: string; // nominal date — the key payments are logged against
  date: string; // expected date after the weekend rule
  shifted: boolean;
}

/**
 * A payday's occurrences whose EXPECTED date falls in [from, to], limited to
 * nominal dates within the item's startDate..endDate.
 */
export function paydayOccurrences(item: ScheduleItem, from: string, to: string): PaydayOccurrence[] {
  if (item.kind !== 'income' || item.dueDay == null || !item.active) return [];
  const out: PaydayOccurrence[] = [];
  // A weekend shift moves a date by at most 2 days, so scan a little wider.
  const start = parseYmd(addDays(from, -3));
  const end = parseYmd(addDays(to, 3));
  for (let c = new Date(start.getFullYear(), start.getMonth(), 1); c <= end; c = new Date(c.getFullYear(), c.getMonth() + 1, 1)) {
    const dueDate = clampedDate(c.getFullYear(), c.getMonth(), item.dueDay);
    if (dueDate < item.startDate || (item.endDate !== null && dueDate > item.endDate)) continue;
    const date = shiftForWeekend(dueDate, item.weekendShift);
    if (date < from || date > to) continue;
    out.push({ item, dueDate, date, shifted: date !== dueDate });
  }
  return out;
}

export function allPaydayOccurrences(items: ScheduleItem[], from: string, to: string): PaydayOccurrence[] {
  return items
    .flatMap((i) => paydayOccurrences(i, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.item.id - b.item.id);
}

export type PaydayState = 'received' | 'today' | 'upcoming' | 'unlogged';

export interface PaydayStatus {
  state: PaydayState;
  receivedCents: number;
  payments: SchedulePayment[]; // logged through the Schedule
  matched: ScheduleActivity[]; // income added elsewhere that lines up with this payday
}

/**
 * Received = salary logged against the occurrence, plus income transactions
 * that landed in the payday's deposit account (and category, when set) from
 * 3 days before to 5 days after the expected date — so salary recorded on
 * the Transactions page counts too. Each transaction counts once: rows
 * already linked to any payment are skipped, and a matched row is consumed.
 */
export function paydayStatuses(
  occurrences: PaydayOccurrence[],
  data: ScheduleData,
  today: string
): Map<string, PaydayStatus> {
  const linked = new Set(data.payments.map((p) => p.transactionId).filter((id): id is number => id !== null));
  const used = new Set<number>();
  const out = new Map<string, PaydayStatus>();
  for (const occ of [...occurrences].sort((a, b) => a.date.localeCompare(b.date))) {
    const payments = data.payments.filter((p) => p.itemId === occ.item.id && p.dueDate === occ.dueDate);
    const lo = addDays(occ.date, -3);
    const hi = addDays(occ.date, 5);
    const matched = data.activity.filter(
      (a) =>
        a.source === 'transaction' &&
        a.type === 'income' &&
        !linked.has(a.id) &&
        !used.has(a.id) &&
        a.accountId !== null &&
        a.accountId === occ.item.accountId &&
        (occ.item.categoryId === null || a.categoryId === occ.item.categoryId) &&
        a.date >= lo &&
        a.date <= hi
    );
    for (const a of matched) used.add(a.id);
    const receivedCents =
      payments.reduce((s, p) => s + p.amountCents, 0) + matched.reduce((s, a) => s + a.amountCents, 0);
    const state: PaydayState =
      receivedCents > 0 ? 'received' : occ.date > today ? 'upcoming' : occ.date === today ? 'today' : 'unlogged';
    out.set(occurrenceKey(occ.item.id, occ.dueDate), { state, receivedCents, payments, matched });
  }
  return out;
}

// ---------- scheduled items (outflows) ----------

export const KIND_LABEL: Record<ScheduleKind, string> = {
  income: 'Payday',
  loan: 'Loan',
  card: 'Card',
  bill: 'Bill',
  allowance: 'Allowance',
  savings: 'Savings',
  subscription: 'Subscription',
};

export const WEEKDAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What item occurrences are computed from besides the items themselves. */
export interface ScheduleContext {
  accounts: Account[];
  subscriptions: Subscription[];
}

/** Monthly due days: a loan/card's come from its account (one source of truth); bills and savings carry their own. */
export function monthlyDueDays(item: ScheduleItem, accounts: Account[]): number[] {
  if (item.kind === 'loan' || item.kind === 'card') {
    const a = accounts.find((x) => x.id === item.accountId);
    return a ? [a.dueDay, a.dueDay2].filter((d): d is number => d != null) : [];
  }
  if ((item.kind === 'bill' || item.kind === 'savings') && item.dueDay != null) return [item.dueDay];
  return [];
}

/** Amount per occurrence: the fixed amount, a bill's 3-month estimate (falling back to its amount), or the subscription's price. */
export function occurrenceAmount(item: ScheduleItem, ctx: ScheduleContext): number {
  if (item.kind === 'subscription') {
    return ctx.subscriptions.find((s) => s.id === item.subscriptionId)?.amountCents ?? 0;
  }
  if (item.amountMode === 'avg3') return item.estimateCents ?? item.amountCents;
  return item.amountCents;
}

/** One cycle after `date`, mirroring the server's subscription advance (Repo::advanceSubDate). */
function nextSubscriptionDate(date: string, sub: Subscription): string {
  const [y, m, d] = date.split('-').map(Number);
  if (sub.cycle === 'interval') return addDays(date, Math.max(1, sub.intervalDays ?? 1));
  const anchor = sub.billDay ?? d;
  if (sub.cycle === 'yearly') return clampedDate(y + 1, m - 1, anchor);
  return clampedDate(m === 12 ? y + 1 : y, m % 12, anchor);
}

export interface ItemOccurrence {
  item: ScheduleItem;
  dueDate: string; // the key payments are logged against
  amountCents: number;
}

/**
 * An item's occurrences due within [from, to], limited to its
 * startDate..endDate. Subscriptions only look forward from their next charge
 * date — earlier cycles were already charged automatically.
 */
export function itemOccurrences(item: ScheduleItem, ctx: ScheduleContext, from: string, to: string): ItemOccurrence[] {
  if (!item.active || item.kind === 'income') return [];
  const lo = from < item.startDate ? item.startDate : from;
  const hi = item.endDate !== null && item.endDate < to ? item.endDate : to;
  if (lo > hi) return [];
  const amountCents = occurrenceAmount(item, ctx);
  const out: ItemOccurrence[] = [];

  if (item.kind === 'allowance') {
    if (item.weekDay == null) return out;
    for (let d = addDays(lo, (item.weekDay - parseYmd(lo).getDay() + 7) % 7); d <= hi; d = addDays(d, 7)) {
      out.push({ item, dueDate: d, amountCents });
    }
    return out;
  }

  if (item.kind === 'subscription') {
    const sub = ctx.subscriptions.find((s) => s.id === item.subscriptionId);
    if (!sub || !sub.active || sub.accountId === null) return out;
    for (let d = sub.nextDate, i = 0; d <= hi && i < 1000; d = nextSubscriptionDate(d, sub), i++) {
      if (d >= lo) out.push({ item, dueDate: d, amountCents });
    }
    return out;
  }

  const days = monthlyDueDays(item, ctx.accounts);
  const start = parseYmd(lo);
  const end = parseYmd(hi);
  for (let c = new Date(start.getFullYear(), start.getMonth(), 1); c <= end; c = new Date(c.getFullYear(), c.getMonth() + 1, 1)) {
    // Two due days can clamp to the same date (30th + 31st in February).
    const dates = [...new Set(days.map((day) => clampedDate(c.getFullYear(), c.getMonth(), day)))].sort();
    for (const d of dates) if (d >= lo && d <= hi) out.push({ item, dueDate: d, amountCents });
  }
  return out;
}

/** Date of the n-th occurrence on or after `from` — turns "6 payments left" into an end date. */
export function nthOccurrenceDate(item: ScheduleItem, ctx: ScheduleContext, from: string, n: number): string | null {
  if (n < 1) return null;
  const open = { ...item, startDate: from, endDate: null };
  return itemOccurrences(open, ctx, from, addDays(from, 3700))[n - 1]?.dueDate ?? null;
}

/** Occurrences from `from` through the item's end date (null when it never ends). */
export function remainingCount(item: ScheduleItem, ctx: ScheduleContext, from: string): number | null {
  if (item.endDate === null) return null;
  return itemOccurrences(item, ctx, from, item.endDate).length;
}

/**
 * The payday occurrence that funds an outflow due on `dueDate`: the latest
 * one expected on or before it — only the pinned payday's when the item
 * names one. `paydays` must reach back far enough (a month or so).
 */
export function fundingPayday(
  item: ScheduleItem,
  dueDate: string,
  paydays: PaydayOccurrence[]
): PaydayOccurrence | undefined {
  let best: PaydayOccurrence | undefined;
  for (const p of paydays) {
    if (p.date > dueDate) continue;
    if (item.fundedBy !== null && p.item.id !== item.fundedBy) continue;
    if (!best || p.date > best.date) best = p;
  }
  return best;
}

/** Subscriptions charged to a credit card don't leave cash directly — the card's payment covers them. */
export function chargedToCard(item: ScheduleItem, ctx: ScheduleContext): boolean {
  if (item.kind !== 'subscription') return false;
  const sub = ctx.subscriptions.find((s) => s.id === item.subscriptionId);
  return ctx.accounts.find((a) => a.id === sub?.accountId)?.type === 'credit';
}

/** Rough monthly cost, for the summary (weekly × 52/12; yearly ÷ 12; every-N-days × 30/N). */
export function monthlyCents(item: ScheduleItem, ctx: ScheduleContext): number {
  const amount = occurrenceAmount(item, ctx);
  if (item.kind === 'allowance') return Math.round((amount * 52) / 12);
  if (item.kind === 'subscription') {
    const sub = ctx.subscriptions.find((s) => s.id === item.subscriptionId);
    if (!sub) return 0;
    if (sub.cycle === 'yearly') return Math.round(sub.amountCents / 12);
    if (sub.cycle === 'interval') return Math.round((sub.amountCents * 30) / Math.max(1, sub.intervalDays ?? 30));
    return sub.amountCents;
  }
  return amount * monthlyDueDays(item, ctx.accounts).length;
}

/**
 * The saved items plus a stand-in (negative id) for each subscription that
 * has no schedule row yet. Subscriptions are always on the schedule; a real
 * row only exists once its funding payday is pinned.
 */
export function withSubscriptions(items: ScheduleItem[], subscriptions: Subscription[]): ScheduleItem[] {
  const covered = new Set(items.map((i) => i.subscriptionId).filter((id): id is number => id !== null));
  const standIns: ScheduleItem[] = subscriptions
    .filter((s) => !covered.has(s.id))
    .map((s) => ({
      id: -s.id,
      name: s.name,
      kind: 'subscription',
      accountId: null,
      subscriptionId: s.id,
      categoryId: null,
      amountMode: 'fixed',
      amountCents: 0,
      matchKeyword: null,
      dueDay: null,
      weekDay: null,
      fundedBy: null,
      weekendShift: 'none',
      startDate: '1970-01-01',
      endDate: null,
      goalCents: null,
      goalMilestones: [],
      payFromAccountId: null,
      active: true,
      estimateCents: null,
      estimateFrom: null,
      estimateTo: null,
    }));
  return [...items, ...standIns];
}

/** An item back as API input (to save one changed field). */
export function toInput(item: ScheduleItem): ScheduleItemInput {
  return {
    kind: item.kind,
    name: item.name,
    accountId: item.accountId,
    subscriptionId: item.subscriptionId,
    categoryId: item.categoryId,
    amountMode: item.amountMode,
    amountCents: item.amountCents,
    matchKeyword: item.matchKeyword,
    dueDay: item.dueDay,
    weekDay: item.weekDay,
    fundedBy: item.fundedBy,
    weekendShift: item.weekendShift,
    startDate: null,
    endDate: item.endDate,
    goalCents: item.goalCents,
    goalMilestones: item.goalMilestones,
    payFromAccountId: item.payFromAccountId,
    active: item.active,
  };
}

/** The 3 complete calendar months before this one — the server's avg3 window (Repo::estimateWindow). */
export function estimateWindow(today: string): [string, string] {
  const d = parseYmd(today);
  return [toYmd(new Date(d.getFullYear(), d.getMonth() - 3, 1)), toYmd(new Date(d.getFullYear(), d.getMonth(), 0))];
}

/** 'Jul–Sep' */
export function windowLabel([from, to]: [string, string]): string {
  const m = (s: string) => parseYmd(s).toLocaleDateString('en-US', { month: 'short' });
  return `${m(from)}–${m(to)}`;
}

// ---------- due status (paid / partial / overdue) ----------

// 'lapsed' = a past allowance week nothing was marked against. Allowances are
// spending money, not bills: that week's groceries are already in your
// balance, so it's never "overdue" and never deducted again.
export type DueState = 'paid' | 'partial' | 'overdue' | 'today' | 'upcoming' | 'lapsed';

/**
 * Past its due date and not fully paid. A partly paid date stays 'partial'
 * in dueStatuses (it carries what's left), but once its date has passed it
 * is overdue like any other — every view should say so.
 */
export function isPastDue(o: { dueDate: string }, st: DueStatus | undefined, today: string): boolean {
  return o.dueDate < today && (st?.state === 'overdue' || st?.state === 'partial');
}

export interface DueStatus {
  state: DueState;
  paidCents: number;
  remainingCents: number; // still owed for this due date (0 once paid)
  extraCents: number; // paid beyond the amount due
  payments: SchedulePayment[]; // paid through the Schedule
  matched: ScheduleActivity[]; // paid elsewhere (Accounts → Pay, Transactions), matched to it
}

/**
 * A ledger row that wasn't paid through the Schedule but can still settle
 * an item: a payment INTO its loan/card/savings account, or an expense in a
 * bill's category (with its keyword, when it has one). Allowances only
 * count what's paid through the Schedule — groceries alone don't say which
 * week they belong to.
 */
function activityMatches(item: ScheduleItem, a: ScheduleActivity): boolean {
  if (item.kind === 'loan' || item.kind === 'card' || item.kind === 'savings') {
    return a.source === 'transfer' && a.accountId !== null && a.accountId === item.accountId;
  }
  if (item.kind === 'bill') {
    const needle = item.matchKeyword?.toLowerCase();
    return (
      a.source === 'transaction' &&
      a.type === 'expense' &&
      a.categoryId !== null &&
      a.categoryId === item.categoryId &&
      (!needle || a.note.toLowerCase().includes(needle))
    );
  }
  return false;
}

/**
 * Paid / partial / overdue for each occurrence. Payments made through the
 * Schedule count for exactly the due date they were made for. Other matching
 * payments (see activityMatches) settle the item's EARLIEST unpaid due date
 * that's at most 45 days before or 31 days after the payment — so a late
 * payment clears the overdue one first and an early one counts for the next.
 * Payments dated before the item was added never count; each payment counts
 * once. Pass every occurrence (including recent past ones) so late payments
 * land on the right date.
 */
export function dueStatuses(occurrences: ItemOccurrence[], data: ScheduleData, today: string): Map<string, DueStatus> {
  const linkedTransfers = new Set(data.payments.map((p) => p.transferId).filter((id) => id !== null));
  const linkedTx = new Set(data.payments.map((p) => p.transactionId).filter((id) => id !== null));
  const unlinked = data.activity
    .filter((a) => !(a.source === 'transfer' ? linkedTransfers : linkedTx).has(a.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const paid = new Map<string, number>();
  const payments = new Map<string, SchedulePayment[]>();
  const matched = new Map<string, ScheduleActivity[]>();
  for (const occ of occurrences) {
    const key = occurrenceKey(occ.item.id, occ.dueDate);
    const own = data.payments.filter((p) => p.itemId === occ.item.id && p.dueDate === occ.dueDate);
    payments.set(key, own);
    matched.set(key, []);
    paid.set(key, own.reduce((s, p) => s + p.amountCents, 0));
  }

  const byItem = new Map<number, ItemOccurrence[]>();
  for (const occ of occurrences) byItem.set(occ.item.id, [...(byItem.get(occ.item.id) ?? []), occ]);
  const used = new Set<string>();
  // Bills with a keyword pick their payments first: an expense that names
  // Meralco belongs to the Meralco bill, not to a catch-all bill in the same
  // category that happens to fall due earlier.
  const lists = [...byItem.values()].sort(
    (a, b) => Number(!a[0].item.matchKeyword) - Number(!b[0].item.matchKeyword)
  );
  for (const list of lists) {
    list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const item = list[0].item;
    for (const row of unlinked) {
      const rowKey = `${row.source}:${row.id}`;
      if (used.has(rowKey) || row.date < item.startDate || !activityMatches(item, row)) continue;
      const lo = addDays(row.date, -45);
      const hi = addDays(row.date, 31);
      const target = list.find((o) => {
        const k = occurrenceKey(o.item.id, o.dueDate);
        return o.dueDate >= lo && o.dueDate <= hi && (paid.get(k) ?? 0) < o.amountCents;
      });
      if (!target) continue;
      const k = occurrenceKey(target.item.id, target.dueDate);
      used.add(rowKey);
      matched.get(k)?.push(row);
      paid.set(k, (paid.get(k) ?? 0) + row.amountCents);
    }
  }

  const out = new Map<string, DueStatus>();
  for (const occ of occurrences) {
    const key = occurrenceKey(occ.item.id, occ.dueDate);
    const paidCents = paid.get(key) ?? 0;
    const remainingCents = Math.max(0, occ.amountCents - paidCents);
    // A bill with no estimate yet (amount 0) is only "paid" once something is paid.
    const settled = paidCents > 0 && remainingCents === 0;
    const state: DueState = settled
      ? 'paid'
      : occ.item.kind === 'allowance' && occ.dueDate < today
        ? 'lapsed'
        : paidCents > 0
          ? 'partial'
          : occ.dueDate < today
            ? 'overdue'
            : occ.dueDate === today
              ? 'today'
              : 'upcoming';
    out.set(key, {
      state,
      paidCents,
      remainingCents,
      extraCents: Math.max(0, paidCents - occ.amountCents),
      payments: payments.get(key) ?? [],
      matched: matched.get(key) ?? [],
    });
  }
  return out;
}

// ---------- payday planner ----------

export interface PaydayPlan {
  payday: PaydayOccurrence;
  // Earlier than the current payday, shown only because it still funds
  // something upcoming (a pinned bill) — its "left" is no longer meaningful.
  closed: boolean;
  status: PaydayStatus;
  incomeCents: number; // what was received once logged, else what's expected
  outflows: ItemOccurrence[]; // everything this payday funds, by due date
  // Per due date, the larger of what's due and what's been paid — so an
  // extra payment uses up more of the payday, a partial one doesn't free any.
  scheduledCents: number;
  paidCents: number;
  leftCents: number; // negative = over-allocated
}

export interface Planner {
  plans: PaydayPlan[];
  statuses: Map<string, DueStatus>; // by occurrenceKey
  overdue: ItemOccurrence[]; // past due, not fully paid, and on no card shown
  unfunded: ItemOccurrence[]; // due from today on, with no payday on or before them
}

// Far enough back that a payday pinned for a due date ~a month later is seen.
const PLAN_LOOKBACK_DAYS = 62;

/**
 * Splits upcoming outflows across the paydays that fund them (see
 * fundingPayday). Shown: the current payday (latest on or before today), the
 * next `ahead` paydays, any earlier payday that still funds something due
 * today or later, and any payday in the last 35 days whose salary isn't
 * logged yet (so it can be). Card-charged subscriptions are left out — the
 * card's own payment covers them.
 */
export function buildPlanner(
  items: ScheduleItem[],
  data: ScheduleData,
  ctx: ScheduleContext,
  today: string,
  ahead: number
): Planner {
  const paydays = items.filter((i) => i.kind === 'income');
  if (paydays.length === 0) return { plans: [], statuses: new Map(), overdue: [], unfunded: [] };
  const from = addDays(today, -PLAN_LOOKBACK_DAYS);
  // ~31 days per two paydays is plenty; the extra month lets the last card's
  // own funded items (and the payday after it) be found.
  const to = addDays(today, (ahead + 2) * 31 + 31);
  const paydayOccs = allPaydayOccurrences(paydays, from, to);
  const paydayStates = paydayStatuses(paydayOccs, data, today);

  const outflows = items
    .filter((i) => i.kind !== 'income' && !chargedToCard(i, ctx))
    .flatMap((i) => itemOccurrences(i, ctx, from, to))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.item.name.localeCompare(b.item.name));
  const statuses = dueStatuses(outflows, data, today);
  const committed = (o: ItemOccurrence) =>
    Math.max(o.amountCents, statuses.get(occurrenceKey(o.item.id, o.dueDate))?.paidCents ?? 0);

  const byPayday = new Map<string, ItemOccurrence[]>();
  const unfunded: ItemOccurrence[] = [];
  const fundsUpcoming = new Set<string>();
  for (const occ of outflows) {
    const payday = fundingPayday(occ.item, occ.dueDate, paydayOccs);
    if (!payday) {
      if (occ.dueDate >= today) unfunded.push(occ);
      continue;
    }
    const key = occurrenceKey(payday.item.id, payday.dueDate);
    byPayday.set(key, [...(byPayday.get(key) ?? []), occ]);
    if (occ.dueDate >= today) fundsUpcoming.add(key);
  }

  const past = paydayOccs.filter((p) => p.date <= today);
  const current = past[past.length - 1];
  const upcoming = paydayOccs.filter((p) => p.date > today).slice(0, ahead);
  const lastShown = upcoming[upcoming.length - 1]?.date ?? current?.date ?? today;
  const recent = addDays(today, -35);
  const shown = paydayOccs.filter((p) => {
    const key = occurrenceKey(p.item.id, p.dueDate);
    return (
      p === current ||
      upcoming.includes(p) ||
      (p.date <= lastShown && fundsUpcoming.has(key)) ||
      (p.date >= recent && p.date <= today && paydayStates.get(key)?.state === 'unlogged')
    );
  });

  const plans = shown.map((payday): PaydayPlan => {
    const key = occurrenceKey(payday.item.id, payday.dueDate);
    const status = paydayStates.get(key) as PaydayStatus;
    const funded = byPayday.get(key) ?? [];
    const incomeCents = status.state === 'received' ? status.receivedCents : payday.item.amountCents;
    const scheduledCents = funded.reduce((s, o) => s + committed(o), 0);
    const paidCents = funded.reduce(
      (s, o) => s + (statuses.get(occurrenceKey(o.item.id, o.dueDate))?.paidCents ?? 0),
      0
    );
    return {
      payday,
      closed: current !== undefined && payday.date < current.date,
      status,
      incomeCents,
      outflows: funded,
      scheduledCents,
      paidCents,
      leftCents: incomeCents - scheduledCents,
    };
  });

  // Anything past due and unsettled that no card shows (its payday's period
  // has closed) still has to surface somewhere.
  const onCards = new Set(plans.flatMap((p) => p.outflows));
  const overdue = outflows.filter(
    (o) => isPastDue(o, statuses.get(occurrenceKey(o.item.id, o.dueDate)), today) && !onCards.has(o)
  );
  return { plans, statuses, overdue, unfunded: unfunded.filter((o) => o.dueDate <= lastShown) };
}

// ---------- calendar ----------

// What a due-date chip shows. 'atrisk' comes from the cash forecast (the
// balance won't cover it); 'auto' = a subscription that charges itself.
export type CalendarState = 'paid' | 'upcoming' | 'atrisk' | 'overdue' | 'past' | 'auto';

export interface CalendarEntry {
  occurrence: ItemOccurrence;
  status: DueStatus | undefined;
  state: CalendarState;
  shortCents: number;
}

export interface CalendarPayday {
  payday: PaydayOccurrence;
  status: PaydayStatus;
}

export interface CalendarDay {
  date: string;
  inMonth: boolean;
  paydays: CalendarPayday[]; // on the EXPECTED date (after the weekend rule)
  entries: CalendarEntry[];
}

/**
 * The month grid: whole weeks (Sunday first) covering `month` ('YYYY-MM').
 * Statuses are computed over the planner's span (from ~2 months back) so a
 * date reads the same here as on the planner; at-risk comes from the forecast
 * (`shortBy`, next 60 days).
 */
export function buildCalendar(
  month: string,
  items: ScheduleItem[],
  data: ScheduleData,
  ctx: ScheduleContext,
  today: string,
  shortBy: Map<string, number>
): CalendarDay[] {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const gridStart = toYmd(new Date(y, m - 1, 1 - first.getDay()));
  const gridEnd = toYmd(new Date(y, m - 1, last.getDate() + (6 - last.getDay())));
  const lookback = addDays(today, -PLAN_LOOKBACK_DAYS);
  const from = gridStart < lookback ? gridStart : lookback;
  const to = gridEnd > today ? gridEnd : today;

  const outflows = items
    .filter((i) => i.kind !== 'income' && !chargedToCard(i, ctx))
    .flatMap((i) => itemOccurrences(i, ctx, from, to));
  const statuses = dueStatuses(outflows, data, today);
  const paydayOccs = allPaydayOccurrences(
    items.filter((i) => i.kind === 'income'),
    from,
    to
  );
  const paydayStates = paydayStatuses(paydayOccs, data, today);

  const byDate = new Map<string, CalendarEntry[]>();
  for (const occurrence of outflows) {
    if (occurrence.dueDate < gridStart || occurrence.dueDate > gridEnd) continue;
    const key = occurrenceKey(occurrence.item.id, occurrence.dueDate);
    const status = statuses.get(key);
    const shortCents = shortBy.get(key) ?? 0;
    const state: CalendarState =
      status?.state === 'paid'
        ? 'paid'
        : status?.state === 'lapsed'
          ? 'past'
          : isPastDue(occurrence, status, today)
            ? 'overdue'
            : shortCents > 0
              ? 'atrisk'
              : occurrence.item.kind === 'subscription'
                ? 'auto'
                : 'upcoming';
    byDate.set(occurrence.dueDate, [...(byDate.get(occurrence.dueDate) ?? []), { occurrence, status, state, shortCents }]);
  }

  const days: CalendarDay[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
    days.push({
      date: d,
      inMonth: d.slice(0, 7) === month,
      paydays: paydayOccs
        .filter((p) => p.date === d)
        .map((payday) => ({
          payday,
          status: paydayStates.get(occurrenceKey(payday.item.id, payday.dueDate)) as PaydayStatus,
        })),
      entries: (byDate.get(d) ?? []).sort((a, b) => a.occurrence.item.name.localeCompare(b.occurrence.item.name)),
    });
  }
  return days;
}

// ---------- reminders ----------

/** How many days ahead a due date starts showing in the reminders. */
export const REMIND_DAYS = 3;

// 'unlogged' = a payday in the last REMIND_DAYS days whose salary isn't logged.
export type ReminderStage = 'overdue' | 'unlogged' | 'today' | 'soon';

// `key` includes the stage, so a reminder already seen comes back when its
// due date arrives, and again if it passes unpaid.
export type Reminder =
  | { kind: 'due'; key: string; stage: ReminderStage; date: string; occurrence: ItemOccurrence; status: DueStatus }
  | { kind: 'payday'; key: string; stage: ReminderStage; date: string; payday: PaydayOccurrence; status: PaydayStatus };

const STAGE_ORDER: Record<ReminderStage, number> = { overdue: 0, unlogged: 1, today: 2, soon: 3 };

/**
 * The in-app reminders: each unpaid due date from REMIND_DAYS days before it
 * (and still, once it's past and unpaid), and each payday on its expected
 * date until its salary is logged (for up to REMIND_DAYS days after). Uses
 * the planner's span and filters, so statuses read the same as on the
 * planner. Most urgent first; within a day, income before outflows.
 */
export function buildReminders(items: ScheduleItem[], data: ScheduleData, ctx: ScheduleContext, today: string): Reminder[] {
  const from = addDays(today, -PLAN_LOOKBACK_DAYS);
  const out: Reminder[] = [];

  const outflows = items
    .filter((i) => i.kind !== 'income' && !chargedToCard(i, ctx))
    .flatMap((i) => itemOccurrences(i, ctx, from, addDays(today, REMIND_DAYS)));
  const statuses = dueStatuses(outflows, data, today);
  for (const occurrence of outflows) {
    const key = occurrenceKey(occurrence.item.id, occurrence.dueDate);
    const status = statuses.get(key);
    if (!status || status.state === 'paid' || status.state === 'lapsed') continue;
    const stage: ReminderStage = occurrence.dueDate < today ? 'overdue' : occurrence.dueDate === today ? 'today' : 'soon';
    out.push({ kind: 'due', key: `${stage}|${key}`, stage, date: occurrence.dueDate, occurrence, status });
  }

  const paydays = allPaydayOccurrences(
    items.filter((i) => i.kind === 'income'),
    from,
    today
  );
  const paydayStates = paydayStatuses(paydays, data, today);
  for (const payday of paydays) {
    if (payday.date < addDays(today, -REMIND_DAYS)) continue;
    const key = occurrenceKey(payday.item.id, payday.dueDate);
    const status = paydayStates.get(key);
    if (!status || status.state === 'received') continue;
    const stage: ReminderStage = payday.date === today ? 'today' : 'unlogged';
    out.push({ kind: 'payday', key: `payday-${stage}|${key}`, stage, date: payday.date, payday, status });
  }

  const name = (r: Reminder) => (r.kind === 'due' ? r.occurrence.item.name : r.payday.item.name);
  return out.sort(
    (a, b) =>
      STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] ||
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === 'payday' ? -1 : 1) ||
      name(a).localeCompare(name(b))
  );
}

// ---------- savings goals ----------

// Checkpoints further out than this read as "not on this schedule".
const GOAL_HORIZON_DAYS = 365 * 30;

export interface GoalCheckpoint {
  cents: number;
  isGoal: boolean; // the goal itself (the last checkpoint) vs a milestone
  reached: boolean;
  eta: string | null; // when scheduled contributions get there; null = reached, or never on this schedule
}

export interface GoalProgress {
  item: ScheduleItem;
  account: Account | undefined; // undefined = the account was deleted
  savedCents: number; // the account's balance
  goalCents: number | null;
  checkpoints: GoalCheckpoint[]; // milestones + the goal, ascending
  next: GoalCheckpoint | null; // the first not yet reached
  sharedWith: string[]; // other goals paying into the same account (its balance counts toward each)
}

/**
 * Savings goal progress: what's saved is the live balance of the account the
 * goal pays into, and each milestone / the goal gets an estimated date from
 * the scheduled contributions (unpaid due dates add their remainder; paid
 * ones are already in the balance; contributions stop at the item's end date).
 */
export function buildGoals(items: ScheduleItem[], data: ScheduleData, ctx: ScheduleContext, today: string): GoalProgress[] {
  // Paused goals still show their balance; they just get no dates.
  const goals = items.filter((i) => i.kind === 'savings');
  const occurrences = goals.flatMap((i) =>
    itemOccurrences(i, ctx, addDays(today, -PLAN_LOOKBACK_DAYS), addDays(today, GOAL_HORIZON_DAYS))
  );
  const statuses = dueStatuses(occurrences, data, today);

  return goals.map((item): GoalProgress => {
    const account = ctx.accounts.find((a) => a.id === item.accountId);
    const savedCents = account ? Math.max(0, account.balanceCents) : 0;
    const targets = [...new Set([...item.goalMilestones, ...(item.goalCents !== null ? [item.goalCents] : [])])].sort(
      (a, b) => a - b
    );
    const top = targets[targets.length - 1] ?? 0;

    const eta = new Map<number, string>();
    let balance = savedCents;
    const mine = occurrences.filter((o) => o.item.id === item.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    for (const o of mine) {
      if (balance >= top) break;
      const st = statuses.get(occurrenceKey(o.item.id, o.dueDate));
      if (!st || st.state === 'paid' || st.remainingCents <= 0) continue;
      const date = o.dueDate < today ? today : o.dueDate;
      balance += st.remainingCents;
      for (const t of targets) if (t > savedCents && balance >= t && !eta.has(t)) eta.set(t, date);
    }

    const checkpoints = targets.map((cents) => ({
      cents,
      isGoal: cents === item.goalCents,
      reached: savedCents >= cents,
      eta: eta.get(cents) ?? null,
    }));
    return {
      item,
      account,
      savedCents,
      goalCents: item.goalCents,
      checkpoints,
      next: checkpoints.find((c) => !c.reached) ?? null,
      sharedWith: goals.filter((g) => g.id !== item.id && g.accountId === item.accountId).map((g) => g.name),
    };
  });
}

// ---------- debt payoff ----------

// How far ahead a debt with no end date is walked before it counts as
// "doesn't finish" (~10 years of monthly payments).
const DEBT_HORIZON_DAYS = 3660;

// Installments are rounded to the cent, so a schedule can end a few centavos
// short of the balance (6 × ₱3,914.22 = ₱23,485.32 against ₱23,485.36).
// Lenders settle that on the last payment, and so does the plan: a remainder
// under one unit of the currency is added to the final payment instead of
// leaving the debt "not paid off by the schedule".
const DEBT_ROUNDING_CENTS = 100;

export interface DebtLine {
  account: Account;
  item: ScheduleItem | null; // its loan/card schedule item; null = not on the schedule
  owedCents: number; // today (after any what-if extra)
  paymentCents: number | null; // per due date
  paymentsLeft: number;
  lastPaymentCents: number; // the final payment (smaller when the balance runs out first)
  payoffDate: string | null; // null = not scheduled, or still owed after its last scheduled payment
  leftoverCents: number; // owed after the last scheduled payment
}

export interface DebtPoint {
  date: string;
  totalCents: number; // total still owed (scheduled debts) after this date's payments
  payments: Array<{ name: string; amountCents: number }>;
}

export interface DebtPlan {
  debts: DebtLine[];
  owedCents: number; // every loan/card balance owed today
  debtFreeDate: string | null; // last payoff among scheduled debts; null if one never finishes or none are scheduled
  points: DebtPoint[]; // today, then each payment date
}

/**
 * Walks every owed loan/card balance down its schedule: each unpaid due date
 * pays its remainder (a fully paid one is skipped, a partial one pays what's
 * left), the last payment is capped at what's still owed, and the debt is
 * paid off on that date. No interest is modelled — installment amounts
 * already include it — and an extra payment shortens the term rather than
 * lowering the installment. Balances are live, so a real extra payment moves
 * the dates on its own; `extra` is a what-if: that much off one debt today.
 */
export function buildDebtPlan(
  items: ScheduleItem[],
  data: ScheduleData,
  ctx: ScheduleContext,
  today: string,
  extra: { accountId: number; amountCents: number } | null = null
): DebtPlan {
  const end = addDays(today, DEBT_HORIZON_DAYS);
  const debtItems = items.filter((i) => (i.kind === 'loan' || i.kind === 'card') && i.active);
  const occurrences = debtItems.flatMap((i) => itemOccurrences(i, ctx, addDays(today, -PLAN_LOOKBACK_DAYS), end));
  const statuses = dueStatuses(occurrences, data, today);
  const paymentsOn = new Map<string, Array<{ name: string; amountCents: number }>>();

  const debts = ctx.accounts
    .filter((a) => (a.type === 'loan' || a.type === 'credit') && a.balanceCents < 0)
    .map((account): DebtLine => {
      const item = debtItems.find((i) => i.accountId === account.id) ?? null;
      let owed = -account.balanceCents;
      if (extra && extra.accountId === account.id) owed = Math.max(0, owed - extra.amountCents);
      const line: DebtLine = {
        account,
        item,
        owedCents: owed,
        paymentCents: item?.amountCents ?? null,
        paymentsLeft: 0,
        lastPaymentCents: 0,
        payoffDate: owed === 0 ? today : null,
        leftoverCents: 0,
      };
      if (!item || owed === 0) return line;

      let balance = owed;
      let last: { date: string; payment: { name: string; amountCents: number } } | null = null;
      const mine = occurrences
        .filter((o) => o.item.id === item.id)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      for (const o of mine) {
        if (balance <= 0) break;
        const st = statuses.get(occurrenceKey(o.item.id, o.dueDate));
        if (!st || st.state === 'paid' || st.remainingCents <= 0) continue;
        const date = o.dueDate < today ? today : o.dueDate; // overdue = pay it now
        const amount = Math.min(balance, st.remainingCents);
        balance -= amount;
        line.paymentsLeft++;
        line.lastPaymentCents = amount;
        const payment = { name: item.name, amountCents: amount };
        paymentsOn.set(date, [...(paymentsOn.get(date) ?? []), payment]);
        last = { date, payment };
        if (balance === 0) line.payoffDate = date;
      }
      if (last && balance > 0 && balance < DEBT_ROUNDING_CENTS) {
        last.payment.amountCents += balance;
        line.lastPaymentCents += balance;
        line.payoffDate = last.date;
        balance = 0;
      }
      line.leftoverCents = balance;
      return line;
    });

  const scheduled = debts.filter((d) => d.item !== null && d.owedCents > 0);
  let total = scheduled.reduce((s, d) => s + d.owedCents, 0);
  const points: DebtPoint[] = [{ date: today, totalCents: total, payments: [] }];
  for (const date of [...paymentsOn.keys()].sort()) {
    const payments = paymentsOn.get(date) ?? [];
    total -= payments.reduce((s, p) => s + p.amountCents, 0);
    points.push({ date, totalCents: total, payments });
  }

  const payoffs = scheduled.map((d) => d.payoffDate);
  const debtFreeDate =
    scheduled.length > 0 && payoffs.every((p) => p !== null)
      ? (payoffs as string[]).reduce((a, b) => (b > a ? b : a))
      : null;
  return { debts, owedCents: debts.reduce((s, d) => s + d.owedCents, 0), debtFreeDate, points };
}

// ---------- cash-flow forecast ----------

export const FORECAST_DAYS = 60;

export interface ForecastEvent {
  date: string; // when it hits the balance (today for anything overdue)
  dueDate: string; // the occurrence it belongs to
  item: ScheduleItem;
  kind: 'in' | 'out';
  amountCents: number; // unpaid remainder for outflows
  overdue: boolean;
  balanceBefore: number;
  balanceAfter: number;
  shortCents: number; // how much of an outflow the balance can't cover (0 = covered)
}

export interface ForecastDay {
  date: string;
  balanceCents: number; // end of day
  events: ForecastEvent[];
}

export interface Forecast {
  startCents: number;
  cashAccounts: Account[]; // debit accounts counted as spendable
  setAside: Account[]; // debit accounts that savings goals pay into — left out
  days: ForecastDay[]; // today .. today + horizon
  events: ForecastEvent[];
  shortfalls: ForecastEvent[];
  shortBy: Map<string, number>; // occurrenceKey → shortCents, for the planner/calendar
  lowest: { date: string; balanceCents: number };
  endCents: number;
}

/**
 * Does paying this item take money out of the cash being forecast? Not when
 * it's charged to a card (the card's own payment covers it) or paid from a
 * set-aside savings account. No pay-from yet = assume cash.
 */
function leavesCash(item: ScheduleItem, ctx: ScheduleContext, cashIds: Set<number>): boolean {
  if (item.kind === 'subscription') {
    const sub = ctx.subscriptions.find((s) => s.id === item.subscriptionId);
    return sub?.accountId != null && cashIds.has(sub.accountId);
  }
  return item.payFromAccountId === null || cashIds.has(item.payFromAccountId);
}

/**
 * Day-by-day cash projection. Starts from today's balance across debit
 * accounts (savings-goal destinations excluded — that money is spoken for),
 * adds each payday's expected salary on its expected date unless it's already
 * logged, and takes off the UNPAID remainder of every outflow on its due date
 * (anything overdue comes off today). Within a day, income lands first. An
 * outflow the running balance can't fully cover is a shortfall:
 * shortCents = amount − max(0, balance before it).
 */
export function buildForecast(
  items: ScheduleItem[],
  data: ScheduleData,
  ctx: ScheduleContext,
  today: string,
  horizonDays = FORECAST_DAYS
): Forecast {
  const end = addDays(today, horizonDays);
  const setAsideIds = new Set(
    items.filter((i) => i.kind === 'savings' && i.accountId !== null).map((i) => i.accountId as number)
  );
  const cashAccounts = ctx.accounts.filter((a) => a.type === 'debit' && !setAsideIds.has(a.id));
  const setAside = ctx.accounts.filter((a) => a.type === 'debit' && setAsideIds.has(a.id));
  const cashIds = new Set(cashAccounts.map((a) => a.id));
  const startCents = cashAccounts.reduce((s, a) => s + a.balanceCents, 0);

  type Raw = Omit<ForecastEvent, 'balanceBefore' | 'balanceAfter' | 'shortCents'>;
  const raw: Raw[] = [];

  const paydays = items.filter((i) => i.kind === 'income');
  const paydayOccs = allPaydayOccurrences(paydays, addDays(today, -40), end);
  const paydayStates = paydayStatuses(paydayOccs, data, today);
  for (const p of paydayOccs) {
    if (p.date < today) continue;
    if (paydayStates.get(occurrenceKey(p.item.id, p.dueDate))?.state === 'received') continue;
    if (p.item.accountId !== null && !cashIds.has(p.item.accountId)) continue;
    raw.push({ date: p.date, dueDate: p.dueDate, item: p.item, kind: 'in', amountCents: p.item.amountCents, overdue: false });
  }

  // Statuses over the same set the planner uses, so paid/partial agree.
  const outflows = items
    .filter((i) => i.kind !== 'income' && !chargedToCard(i, ctx))
    .flatMap((i) => itemOccurrences(i, ctx, addDays(today, -PLAN_LOOKBACK_DAYS), end));
  const statuses = dueStatuses(outflows, data, today);
  for (const o of outflows) {
    if (!leavesCash(o.item, ctx, cashIds)) continue;
    const st = statuses.get(occurrenceKey(o.item.id, o.dueDate));
    if (!st || st.state === 'paid' || st.state === 'lapsed' || st.remainingCents <= 0) continue;
    const overdue = o.dueDate < today;
    raw.push({
      date: overdue ? today : o.dueDate,
      dueDate: o.dueDate,
      item: o.item,
      kind: 'out',
      amountCents: st.remainingCents,
      overdue,
    });
  }

  const rank = (e: Raw) => (e.kind === 'in' ? 0 : e.overdue ? 1 : 2);
  raw.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      rank(a) - rank(b) ||
      a.dueDate.localeCompare(b.dueDate) ||
      a.item.name.localeCompare(b.item.name)
  );

  let balance = startCents;
  const events: ForecastEvent[] = raw.map((r) => {
    const before = balance;
    balance += r.kind === 'in' ? r.amountCents : -r.amountCents;
    const shortCents = r.kind === 'out' && before < r.amountCents ? r.amountCents - Math.max(0, before) : 0;
    return { ...r, balanceBefore: before, balanceAfter: balance, shortCents };
  });

  const days: ForecastDay[] = [];
  let running = startCents;
  let lowest = { date: today, balanceCents: startCents };
  for (let d = today, i = 0; d <= end; d = addDays(d, 1)) {
    const todays: ForecastEvent[] = [];
    while (i < events.length && events[i].date === d) todays.push(events[i++]);
    if (todays.length) running = todays[todays.length - 1].balanceAfter;
    days.push({ date: d, balanceCents: running, events: todays });
    if (running < lowest.balanceCents) lowest = { date: d, balanceCents: running };
  }

  const shortfalls = events.filter((e) => e.shortCents > 0);
  const shortBy = new Map(shortfalls.map((e) => [occurrenceKey(e.item.id, e.dueDate), e.shortCents]));
  return { startCents, cashAccounts, setAside, days, events, shortfalls, shortBy, lowest, endCents: running };
}

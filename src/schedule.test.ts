import { describe, expect, it } from 'vitest';
import type {
  Account,
  AccountType,
  ScheduleActivity,
  ScheduleData,
  ScheduleItem,
  ScheduleKind,
  SchedulePayment,
  Subscription,
} from '../shared/types';
import {
  addDays,
  allPaydayOccurrences,
  buildCalendar,
  buildDebtPlan,
  buildForecast,
  buildGoals,
  buildPlanner,
  buildReminders,
  chargedToCard,
  clampedDate,
  daysBetween,
  dueStatuses,
  estimateWindow,
  fundingPayday,
  isPastDue,
  itemOccurrences,
  monthlyCents,
  nthOccurrenceDate,
  occurrenceAmount,
  occurrenceKey,
  paydayOccurrences,
  paydayStatuses,
  remainingCount,
  shiftForWeekend,
  shortfallHelp,
  withSubscriptions,
} from './schedule';
import type { ItemOccurrence, ScheduleContext } from './schedule';

// Unit tests for the Schedule's pure date/money rules (src/schedule.ts).
// Everything is computed from a fixed "today" so results never depend on
// when the suite runs. Calendar facts used below:
//   Oct 2026 — 1st Thu, 8th Thu, 23rd Fri, 28th Wed (TODAY), 31st Sat
//   Nov 2026 — 1st Sun, 5th Thu, 6th Fri, 8th Sun, 23rd Mon, 30th Mon
//   Dec 2026 — 8th Tue, 23rd Wed

const TODAY = '2026-10-28';

// ---------- fixtures ----------

let nextId = 1000;

function item(kind: ScheduleKind, over: Partial<ScheduleItem> = {}): ScheduleItem {
  const id = over.id ?? nextId++;
  return {
    id,
    name: `${kind} ${id}`,
    kind,
    accountId: null,
    subscriptionId: null,
    categoryId: null,
    amountMode: 'fixed',
    amountCents: 0,
    matchKeyword: null,
    dueDay: null,
    weekDay: null,
    fundedBy: null,
    weekendShift: 'none',
    startDate: '2026-01-01',
    endDate: null,
    goalCents: null,
    goalMilestones: [],
    payFromAccountId: null,
    active: true,
    estimateCents: null,
    estimateFrom: null,
    estimateTo: null,
    ...over,
  };
}

function account(id: number, type: AccountType, balanceCents: number, over: Partial<Account> = {}): Account {
  return {
    id,
    name: `Account ${id}`,
    type,
    color: '#888888',
    image: null,
    dueDay: null,
    dueDay2: null,
    creditLimitCents: null,
    statementDay: null,
    interestRateBp: null,
    openingBalanceCents: balanceCents,
    balanceCents,
    archivedAt: null,
    txCount: 0,
    transferCount: 0,
    ...over,
  };
}

function subscription(id: number, over: Partial<Subscription> = {}): Subscription {
  return {
    id,
    name: `Sub ${id}`,
    amountCents: 549_00,
    accountId: 1,
    accountName: null,
    accountColor: null,
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    cycle: 'monthly',
    billDay: 30,
    intervalDays: null,
    nextDate: '2026-10-30',
    active: true,
    ...over,
  };
}

let nextPaymentId = 1;

/** A payment made through the Schedule (Mark as paid / Log received). */
function paid(target: ScheduleItem, dueDate: string, amountCents: number, over: Partial<SchedulePayment> = {}): SchedulePayment {
  const id = nextPaymentId++;
  return { id, itemId: target.id, dueDate, transferId: null, transactionId: 9000 + id, amountCents, paidDate: dueDate, ...over };
}

let nextActivityId = 1;

/** A transfer INTO an account, made outside the Schedule (Accounts → Pay). */
function transferIn(accountId: number, date: string, amountCents: number, id = nextActivityId++): ScheduleActivity {
  return { source: 'transfer', id, type: 'transfer', accountId, categoryId: null, date, amountCents, note: '' };
}

/** A transaction added outside the Schedule (Transactions page). */
function tx(type: 'income' | 'expense', over: Partial<ScheduleActivity> & { date: string; amountCents: number }): ScheduleActivity {
  return { source: 'transaction', id: nextActivityId++, type, accountId: 1, categoryId: null, note: '', ...over };
}

function data(items: ScheduleItem[], payments: SchedulePayment[] = [], activity: ScheduleActivity[] = []): ScheduleData {
  return { items, payments, activity };
}

function ctx(accounts: Account[] = [], subscriptions: Subscription[] = []): ScheduleContext {
  return { accounts, subscriptions };
}

const dates = (list: Array<{ dueDate: string }>) => list.map((o) => o.dueDate);

// ---------- dates ----------

describe('date helpers', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('counts whole days between dates, negative when the second is earlier', () => {
    expect(daysBetween('2026-10-28', '2026-11-05')).toBe(8);
    expect(daysBetween('2026-11-05', '2026-10-28')).toBe(-8);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('clamps a day of month to the month length', () => {
    expect(clampedDate(2026, 1, 31)).toBe('2026-02-28');
    expect(clampedDate(2028, 1, 30)).toBe('2028-02-29');
    expect(clampedDate(2026, 3, 31)).toBe('2026-04-30');
    expect(clampedDate(2026, 9, 8)).toBe('2026-10-08');
  });

  it('moves weekend dates to the Friday before or the Monday after', () => {
    // Nov 7 2026 is a Saturday, Nov 8 a Sunday.
    expect(shiftForWeekend('2026-11-07', 'before')).toBe('2026-11-06');
    expect(shiftForWeekend('2026-11-08', 'before')).toBe('2026-11-06');
    expect(shiftForWeekend('2026-11-07', 'after')).toBe('2026-11-09');
    expect(shiftForWeekend('2026-11-08', 'after')).toBe('2026-11-09');
    expect(shiftForWeekend('2026-11-08', 'none')).toBe('2026-11-08');
    expect(shiftForWeekend('2026-11-05', 'before')).toBe('2026-11-05'); // a Thursday
  });

  it('uses the 3 complete months before this one as the bill estimate window', () => {
    expect(estimateWindow('2026-10-28')).toEqual(['2026-07-01', '2026-09-30']);
    expect(estimateWindow('2026-01-15')).toEqual(['2025-10-01', '2025-12-31']);
  });
});

// ---------- paydays ----------

describe('paydayOccurrences', () => {
  const payday8 = item('income', { id: 1, dueDay: 8, weekendShift: 'before', amountCents: 54000_00, accountId: 1 });

  it('keys each payday by its nominal date and expects it on the shifted one', () => {
    expect(paydayOccurrences(payday8, '2026-11-01', '2026-11-30')).toEqual([
      { item: payday8, dueDate: '2026-11-08', date: '2026-11-06', shifted: true },
    ]);
  });

  it('filters by the EXPECTED date, not the nominal one', () => {
    // The 8th is in range but the money arrives on Fri the 6th, which isn't.
    expect(paydayOccurrences(payday8, '2026-11-07', '2026-11-30')).toEqual([]);
    expect(dates(paydayOccurrences(payday8, '2026-10-25', '2026-11-06'))).toEqual(['2026-11-08']);
  });

  it('clamps a 31st payday to short months', () => {
    const payday31 = item('income', { dueDay: 31 });
    expect(dates(paydayOccurrences(payday31, '2026-02-01', '2026-04-30'))).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('respects the start and end dates, and paused paydays have none', () => {
    const limited = item('income', { dueDay: 8, startDate: '2026-11-10', endDate: '2027-01-08' });
    expect(dates(paydayOccurrences(limited, '2026-10-01', '2027-03-31'))).toEqual(['2026-12-08', '2027-01-08']);
    expect(paydayOccurrences({ ...payday8, active: false }, '2026-10-01', '2026-12-31')).toEqual([]);
  });

  it('sorts several paydays by expected date', () => {
    const payday23 = item('income', { id: 2, dueDay: 23, weekendShift: 'before' });
    const list = allPaydayOccurrences([payday23, payday8], '2026-10-01', '2026-11-30');
    expect(list.map((p) => p.date)).toEqual(['2026-10-08', '2026-10-23', '2026-11-06', '2026-11-23']);
  });
});

describe('paydayStatuses', () => {
  const payday = item('income', { id: 1, dueDay: 8, weekendShift: 'before', amountCents: 54000_00, accountId: 1, categoryId: 50 });
  const nov = paydayOccurrences(payday, '2026-11-01', '2026-11-30'); // expected Fri Nov 6
  const key = occurrenceKey(payday.id, '2026-11-08');

  it('counts salary logged through the Schedule, once even though the ledger row is listed too', () => {
    const p = paid(payday, '2026-11-08', 53500_00, { transactionId: 500 });
    const row = tx('income', { id: 500, accountId: 1, categoryId: 50, date: '2026-11-06', amountCents: 53500_00 });
    const st = paydayStatuses(nov, data([payday], [p], [row]), '2026-11-10').get(key);
    expect(st?.state).toBe('received');
    expect(st?.receivedCents).toBe(53500_00);
  });

  it('matches income added on the Transactions page from 3 days before to 5 days after', () => {
    const at = (date: string, over: Partial<ScheduleActivity> = {}) =>
      paydayStatuses(nov, data([payday], [], [tx('income', { accountId: 1, categoryId: 50, date, amountCents: 54000_00, ...over })]), '2026-11-20').get(key)?.state;
    expect(at('2026-11-03')).toBe('received');
    expect(at('2026-11-11')).toBe('received');
    expect(at('2026-11-02')).toBe('unlogged');
    expect(at('2026-11-12')).toBe('unlogged');
    expect(at('2026-11-06', { accountId: 2 })).toBe('unlogged'); // another account
    expect(at('2026-11-06', { categoryId: 51 })).toBe('unlogged'); // another category
  });

  it('accepts any income category when the payday has none', () => {
    const anyCategory = { ...payday, categoryId: null };
    const occ = paydayOccurrences(anyCategory, '2026-11-01', '2026-11-30');
    const row = tx('income', { accountId: 1, categoryId: 77, date: '2026-11-06', amountCents: 54000_00 });
    expect(paydayStatuses(occ, data([anyCategory], [], [row]), '2026-11-20').get(key)?.state).toBe('received');
  });

  it('lets one income transaction count for one payday only', () => {
    const p8 = item('income', { id: 11, dueDay: 8, accountId: 1 });
    const p9 = item('income', { id: 12, dueDay: 9, accountId: 1 });
    const occ = allPaydayOccurrences([p8, p9], '2026-12-01', '2026-12-31');
    const row = tx('income', { accountId: 1, date: '2026-12-09', amountCents: 1000_00 });
    const st = paydayStatuses(occ, data([p8, p9], [], [row]), '2026-12-20');
    expect(st.get(occurrenceKey(11, '2026-12-08'))?.state).toBe('received');
    expect(st.get(occurrenceKey(12, '2026-12-09'))?.state).toBe('unlogged');
  });

  it('is upcoming before the day, today on it, and unlogged after', () => {
    const state = (today: string) => paydayStatuses(nov, data([payday]), today).get(key)?.state;
    expect(state('2026-11-05')).toBe('upcoming');
    expect(state('2026-11-06')).toBe('today'); // the expected date, not the nominal 8th
    expect(state('2026-11-07')).toBe('unlogged');
  });
});

// ---------- outflow occurrences ----------

describe('itemOccurrences', () => {
  it("takes a loan's due days from its account, merging two that clamp to one date", () => {
    const loanAccount = account(10, 'loan', -100000_00, { dueDay: 30, dueDay2: 31 });
    const loan = item('loan', { accountId: 10, amountCents: 5000_00 });
    const occ = itemOccurrences(loan, ctx([loanAccount]), '2026-02-01', '2026-03-31');
    expect(dates(occ)).toEqual(['2026-02-28', '2026-03-30', '2026-03-31']);
    expect(occ.every((o) => o.amountCents === 5000_00)).toBe(true);
  });

  it('repeats an allowance weekly on its weekday', () => {
    const allowance = item('allowance', { weekDay: 6 }); // Saturday
    expect(dates(itemOccurrences(allowance, ctx(), TODAY, '2026-11-15'))).toEqual([
      '2026-10-31',
      '2026-11-07',
      '2026-11-14',
    ]);
  });

  it('stays within the start and end dates; paused items and paydays have none', () => {
    const bill = item('bill', { dueDay: 5, startDate: '2026-11-01', endDate: '2027-01-05' });
    expect(dates(itemOccurrences(bill, ctx(), '2026-10-01', '2027-06-30'))).toEqual([
      '2026-11-05',
      '2026-12-05',
      '2027-01-05',
    ]);
    expect(itemOccurrences({ ...bill, active: false }, ctx(), '2026-10-01', '2027-06-30')).toEqual([]);
    expect(itemOccurrences(item('income', { dueDay: 8 }), ctx(), '2026-10-01', '2026-12-31')).toEqual([]);
  });

  it('walks a subscription forward from its next charge, like the server does', () => {
    const run = (sub: Subscription, from: string, to: string) => {
      const [standIn] = withSubscriptions([], [sub]);
      return dates(itemOccurrences(standIn, ctx([], [sub]), from, to));
    };
    // Monthly on the 31st: clamps in short months, then lands on the 31st again.
    expect(run(subscription(1, { billDay: 31, nextDate: '2027-01-31' }), '2027-01-01', '2027-04-30')).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
    // Yearly on Feb 29: Feb 28 in a non-leap year.
    expect(run(subscription(2, { cycle: 'yearly', billDay: 29, nextDate: '2028-02-29' }), '2028-01-01', '2029-12-31')).toEqual([
      '2028-02-29',
      '2029-02-28',
    ]);
    // Every 10 days; nothing before the next charge (earlier ones were already charged).
    expect(run(subscription(3, { cycle: 'interval', intervalDays: 10, billDay: null, nextDate: '2026-10-30' }), '2026-10-01', '2026-11-20')).toEqual([
      '2026-10-30',
      '2026-11-09',
      '2026-11-19',
    ]);
    expect(run(subscription(4, { active: false }), '2026-10-01', '2026-12-31')).toEqual([]);
    expect(run(subscription(5, { accountId: null }), '2026-10-01', '2026-12-31')).toEqual([]);
  });

  it('turns "N payments left" into an end date and back', () => {
    const loanAccount = account(10, 'loan', -100000_00, { dueDay: 5 });
    const loan = item('loan', { accountId: 10, endDate: '2027-01-05' });
    const c = ctx([loanAccount]);
    expect(nthOccurrenceDate(loan, c, TODAY, 3)).toBe('2027-01-05');
    expect(nthOccurrenceDate(loan, c, TODAY, 0)).toBeNull();
    expect(remainingCount(loan, c, TODAY)).toBe(3);
    expect(remainingCount({ ...loan, endDate: null }, c, TODAY)).toBeNull();
  });
});

describe('amounts and helpers', () => {
  const sub = subscription(1, { amountCents: 549_00 });

  it("uses a bill's 3-month estimate, falling back to its fixed amount", () => {
    expect(occurrenceAmount(item('bill', { amountMode: 'avg3', amountCents: 2000_00, estimateCents: 2500_00 }), ctx())).toBe(2500_00);
    expect(occurrenceAmount(item('bill', { amountMode: 'avg3', amountCents: 2000_00, estimateCents: null }), ctx())).toBe(2000_00);
    expect(occurrenceAmount(withSubscriptions([], [sub])[0], ctx([], [sub]))).toBe(549_00);
  });

  it('estimates a monthly cost per kind', () => {
    const twiceMonthly = account(10, 'credit', -1000_00, { dueDay: 15, dueDay2: 30 });
    expect(monthlyCents(item('allowance', { weekDay: 6, amountCents: 3000_00 }), ctx())).toBe(13000_00); // × 52 / 12
    expect(monthlyCents(item('card', { accountId: 10, amountCents: 5000_00 }), ctx([twiceMonthly]))).toBe(10000_00);
    const yearly = subscription(2, { cycle: 'yearly', amountCents: 1200_00 });
    const every15 = subscription(3, { cycle: 'interval', intervalDays: 15, amountCents: 300_00 });
    const subs = [sub, yearly, every15];
    const [m, y, i] = withSubscriptions([], subs);
    expect([m, y, i].map((s) => monthlyCents(s, ctx([], subs)))).toEqual([549_00, 100_00, 600_00]);
  });

  it('adds a stand-in only for subscriptions without a schedule row', () => {
    const subs = [subscription(1), subscription(2)];
    const pinned = item('subscription', { id: 77, subscriptionId: 2 });
    const all = withSubscriptions([pinned], subs);
    expect(all.map((i) => i.id)).toEqual([77, -1]);
    expect(all[1]).toMatchObject({ kind: 'subscription', subscriptionId: 1, active: true });
  });

  it('knows which subscriptions are charged to a credit card', () => {
    const subs = [subscription(1, { accountId: 1 }), subscription(2, { accountId: 3 })];
    const c = ctx([account(1, 'debit', 0), account(3, 'credit', 0)], subs);
    const [onDebit, onCard] = withSubscriptions([], subs);
    expect(chargedToCard(onDebit, c)).toBe(false);
    expect(chargedToCard(onCard, c)).toBe(true);
    expect(chargedToCard(item('bill'), c)).toBe(false);
  });

  it('funds a due date from the latest payday on or before it, or the pinned one', () => {
    const p8 = item('income', { id: 1, dueDay: 8, weekendShift: 'before' });
    const p23 = item('income', { id: 2, dueDay: 23, weekendShift: 'before' });
    const paydays = allPaydayOccurrences([p8, p23], '2026-10-01', '2026-12-31');
    const auto = item('bill');
    const pinned = item('bill', { fundedBy: 1 });
    expect(fundingPayday(auto, '2026-11-05', paydays)?.date).toBe('2026-10-23');
    expect(fundingPayday(auto, '2026-11-06', paydays)?.date).toBe('2026-11-06'); // same day counts
    expect(fundingPayday(pinned, '2026-11-20', paydays)?.date).toBe('2026-11-06');
    expect(fundingPayday(pinned, '2026-11-05', paydays)?.date).toBe('2026-10-08');
    expect(fundingPayday(auto, '2026-10-05', paydays)).toBeUndefined();
  });
});

// ---------- paid / partial / overdue ----------

describe('dueStatuses', () => {
  const loanAccount = account(10, 'loan', -90000_00, { dueDay: 5 });
  const loan = item('loan', { id: 20, accountId: 10, amountCents: 3000_00, startDate: '2026-09-01' });
  const c = ctx([loanAccount]);
  // Sep 5, Oct 5 (both past), Nov 5, Dec 5.
  const occ = itemOccurrences(loan, c, '2026-08-27', '2026-12-31');
  const status = (d: ScheduleData, dueDate: string, today = TODAY, list = occ) =>
    dueStatuses(list, d, today).get(occurrenceKey(loan.id, dueDate));

  it('settles a due date paid through the Schedule: full, partial, or with extra', () => {
    const d = data([loan], [paid(loan, '2026-10-05', 3000_00), paid(loan, '2026-11-05', 1000_00), paid(loan, '2026-12-05', 4000_00)]);
    expect(status(d, '2026-09-05')).toMatchObject({ state: 'overdue', paidCents: 0, remainingCents: 3000_00 });
    expect(status(d, '2026-10-05')).toMatchObject({ state: 'paid', remainingCents: 0, extraCents: 0 });
    expect(status(d, '2026-11-05')).toMatchObject({ state: 'partial', paidCents: 1000_00, remainingCents: 2000_00 });
    expect(status(d, '2026-12-05')).toMatchObject({ state: 'paid', extraCents: 1000_00 });
  });

  it('applies payments made elsewhere to the earliest unpaid due date, oldest payment first', () => {
    const d = data([loan], [], [transferIn(10, '2026-10-25', 3000_00), transferIn(10, '2026-10-20', 3000_00)]);
    expect(status(d, '2026-09-05')?.state).toBe('paid'); // Oct 20 is 45 days after Sep 5 — still counts
    expect(status(d, '2026-10-05')?.state).toBe('paid');
    expect(status(d, '2026-11-05')?.state).toBe('upcoming');
  });

  it('only matches within 45 days late and 31 days early', () => {
    // Nov 25 is 51 days after Oct 5, so it pays Nov 5 instead.
    const late = data([loan], [paid(loan, '2026-09-05', 3000_00)], [transferIn(10, '2026-11-25', 3000_00)]);
    expect(status(late, '2026-10-05', '2026-11-26')?.state).toBe('overdue');
    expect(status(late, '2026-11-05', '2026-11-26')?.state).toBe('paid');
    // Oct 4 is 32 days before Nov 5: too early once Sep and Oct are settled.
    const early = data([loan], [paid(loan, '2026-09-05', 3000_00), paid(loan, '2026-10-05', 3000_00)], [transferIn(10, '2026-10-04', 3000_00)]);
    expect(status(early, '2026-11-05', '2026-10-04')?.state).toBe('upcoming');
  });

  it("ignores payments from before the item was added", () => {
    const fresh = { ...loan, startDate: '2026-10-01' };
    const list = itemOccurrences(fresh, c, '2026-08-27', '2026-12-31');
    const d = data([fresh], [], [transferIn(10, '2026-09-28', 3000_00)]);
    expect(dueStatuses(list, d, TODAY).get(occurrenceKey(fresh.id, '2026-10-05'))?.state).toBe('overdue');
  });

  it('never counts a Schedule payment twice through its ledger row', () => {
    const d = data([loan], [paid(loan, '2026-10-05', 3000_00, { transferId: 7, transactionId: null })], [transferIn(10, '2026-10-05', 3000_00, 7)]);
    expect(status(d, '2026-10-05')).toMatchObject({ state: 'paid', paidCents: 3000_00 });
    expect(status(d, '2026-09-05')?.state).toBe('overdue');
  });

  it('lets one expense pay one bill, matching category and keyword', () => {
    const power = item('bill', { id: 31, dueDay: 10, categoryId: 7, matchKeyword: 'Meralco', amountCents: 2500_00, startDate: '2026-10-01' });
    const other = item('bill', { id: 32, dueDay: 12, categoryId: 7, amountCents: 500_00, startDate: '2026-10-01' });
    const list = [...itemOccurrences(power, ctx(), '2026-10-01', '2026-10-31'), ...itemOccurrences(other, ctx(), '2026-10-01', '2026-10-31')];
    const state = (activity: ScheduleActivity[]) => {
      const st = dueStatuses(list, data([power, other], [], activity), TODAY);
      return [st.get(occurrenceKey(31, '2026-10-10'))?.state, st.get(occurrenceKey(32, '2026-10-12'))?.state];
    };
    expect(state([tx('expense', { categoryId: 7, note: 'MERALCO october', date: '2026-10-11', amountCents: 2500_00 })])).toEqual(['paid', 'overdue']);
    // Without the keyword it can only be the other bill; another category or income never counts.
    expect(state([tx('expense', { categoryId: 7, note: 'water', date: '2026-10-11', amountCents: 2500_00 })])).toEqual(['overdue', 'paid']);
    expect(state([tx('expense', { categoryId: 8, note: 'meralco', date: '2026-10-11', amountCents: 2500_00 })])).toEqual(['overdue', 'overdue']);
    expect(state([tx('income', { categoryId: 7, note: 'meralco', date: '2026-10-11', amountCents: 2500_00 })])).toEqual(['overdue', 'overdue']);
  });

  it("gives an expense naming a bill's keyword to that bill, even when a catch-all bill comes first", () => {
    // Water (no keyword) takes any Utilities expense; Meralco only ones that say so.
    // Water's due date is earlier, so it's looked at first.
    const water = item('bill', { id: 33, dueDay: 8, categoryId: 7, amountCents: 2500_00, startDate: '2026-10-01' });
    const power = item('bill', { id: 34, dueDay: 10, categoryId: 7, matchKeyword: 'meralco', amountCents: 2500_00, startDate: '2026-10-01' });
    const list = [...itemOccurrences(water, ctx(), '2026-10-01', '2026-10-31'), ...itemOccurrences(power, ctx(), '2026-10-01', '2026-10-31')];
    const d = data([water, power], [], [tx('expense', { categoryId: 7, note: 'Meralco Oct', date: '2026-10-11', amountCents: 2500_00 })]);
    const st = dueStatuses(list, d, TODAY);
    expect(st.get(occurrenceKey(34, '2026-10-10'))?.state).toBe('paid');
    expect(st.get(occurrenceKey(33, '2026-10-08'))?.state).toBe('overdue');
  });

  it('marks unmarked past allowance weeks lapsed, never overdue, and only counts Schedule payments', () => {
    const allowance = item('allowance', { id: 40, weekDay: 6, categoryId: 9, amountCents: 3000_00, startDate: '2026-10-01' });
    const list = itemOccurrences(allowance, ctx(), '2026-10-01', '2026-11-07');
    const d = data([allowance], [paid(allowance, '2026-10-17', 3000_00)], [tx('expense', { categoryId: 9, date: '2026-10-24', amountCents: 3000_00 })]);
    const st = dueStatuses(list, d, TODAY);
    const at = (date: string) => st.get(occurrenceKey(40, date))?.state;
    expect([at('2026-10-03'), at('2026-10-10'), at('2026-10-17'), at('2026-10-24'), at('2026-10-31')]).toEqual([
      'lapsed',
      'lapsed',
      'paid',
      'lapsed', // the groceries expense doesn't say which week it was for
      'upcoming',
    ]);
  });

  it('marks a due date today, and treats a bill with no estimate as unpaid until something is paid', () => {
    expect(status(data([loan]), '2026-11-05', '2026-11-05')?.state).toBe('today');
    const unknown = item('bill', { id: 50, dueDay: 20, amountMode: 'avg3', amountCents: 0, startDate: '2026-10-01' });
    const list = itemOccurrences(unknown, ctx(), '2026-10-01', '2026-10-31');
    expect(dueStatuses(list, data([unknown]), TODAY).get(occurrenceKey(50, '2026-10-20'))).toMatchObject({ state: 'overdue', remainingCents: 0 });
    const settled = dueStatuses(list, data([unknown], [paid(unknown, '2026-10-20', 1800_00)]), TODAY);
    expect(settled.get(occurrenceKey(50, '2026-10-20'))?.state).toBe('paid');
  });
});

// ---------- payday planner ----------

describe('buildPlanner', () => {
  // Paydays (Friday before on weekends): Sep 8, Sep 23, Oct 8, Oct 23, Nov 6 (8th is a Sunday), Nov 23, Dec 8 …
  const p8 = item('income', { id: 1, name: 'Payday 8th', dueDay: 8, weekendShift: 'before', amountCents: 54000_00, accountId: 1 });
  const p23 = item('income', { id: 2, name: 'Payday 23rd', dueDay: 23, weekendShift: 'before', amountCents: 54000_00, accountId: 1 });
  const loan = item('loan', { id: 20, name: 'Car loan', accountId: 10, amountCents: 30000_00, startDate: '2026-10-01' });
  const water = item('bill', { id: 21, name: 'Water', dueDay: 30, amountCents: 4000_00, startDate: '2026-10-01' });
  const rent = item('bill', { id: 22, name: 'Rent', dueDay: 15, amountCents: 60000_00, startDate: '2026-11-01' });
  const items = [p8, p23, loan, water, rent];
  const c = ctx([account(1, 'debit', 20000_00), account(10, 'loan', -300000_00, { dueDay: 5 })]);
  const salary = [paid(p23, '2026-09-23', 54000_00), paid(p8, '2026-10-08', 54000_00), paid(p23, '2026-10-23', 53850_00)];
  const summary = (plan: ReturnType<typeof buildPlanner>) =>
    plan.plans.map((p) => ({
      date: p.payday.date,
      due: p.outflows.map((o) => `${o.item.name} ${o.dueDate}`),
      income: p.incomeCents,
      scheduled: p.scheduledCents,
      left: p.leftCents,
    }));

  it('splits what is due across the paydays that fund it, and flags over-allocated ones', () => {
    const plan = buildPlanner(items, data(items, salary), c, TODAY, 3);
    expect(summary(plan)).toEqual([
      // The current payday counts what was actually received.
      { date: '2026-10-23', due: ['Water 2026-10-30', 'Car loan 2026-11-05'], income: 53850_00, scheduled: 34000_00, left: 19850_00 },
      { date: '2026-11-06', due: ['Rent 2026-11-15'], income: 54000_00, scheduled: 60000_00, left: -6000_00 },
      { date: '2026-11-23', due: ['Water 2026-11-30', 'Car loan 2026-12-05'], income: 54000_00, scheduled: 34000_00, left: 20000_00 },
      { date: '2026-12-08', due: ['Rent 2026-12-15'], income: 54000_00, scheduled: 60000_00, left: -6000_00 },
    ]);
    expect(plan.plans.every((p) => !p.closed)).toBe(true);
    // Oct 5's payday card (Sep 23) isn't shown, so the unpaid installment surfaces on its own.
    expect(dates(plan.overdue)).toEqual(['2026-10-05']);
    expect(plan.unfunded).toEqual([]);
  });

  it('counts an extra payment against its payday', () => {
    const plan = buildPlanner(items, data(items, [...salary, paid(loan, '2026-11-05', 35000_00)]), c, TODAY, 3);
    expect(plan.plans[0]).toMatchObject({ scheduledCents: 39000_00, paidCents: 35000_00, leftCents: 14850_00 });
  });

  it('shows an earlier payday, closed, while it still funds a pinned upcoming bill', () => {
    const insurance = item('bill', { id: 23, name: 'Insurance', dueDay: 3, amountCents: 8000_00, fundedBy: 1, startDate: '2026-11-01' });
    const all = [...items, insurance];
    const plan = buildPlanner(all, data(all, salary), c, TODAY, 3);
    const oct8 = plan.plans.find((p) => p.payday.date === '2026-10-08');
    expect(oct8?.closed).toBe(true);
    expect(oct8?.outflows.map((o) => o.item.name)).toEqual(['Insurance']);
  });

  it('shows a recent payday whose salary was never logged', () => {
    const plan = buildPlanner(items, data(items, salary.filter((p) => p.dueDate !== '2026-10-08')), c, TODAY, 3);
    const oct8 = plan.plans.find((p) => p.payday.date === '2026-10-08');
    expect(oct8?.status.state).toBe('unlogged');
  });

  it('leaves out subscriptions charged to a card', () => {
    const subs = [
      subscription(1, { name: 'Netflix', accountId: 1, nextDate: '2026-11-10' }),
      subscription(2, { name: 'Spotify', accountId: 3, nextDate: '2026-11-10' }),
    ];
    const withSubs = withSubscriptions(items, subs);
    const plan = buildPlanner(withSubs, data(items, salary), ctx([...c.accounts, account(3, 'credit', -500_00)], subs), TODAY, 3);
    const names = plan.plans.flatMap((p) => p.outflows.map((o) => o.item.name));
    expect(names).toContain('Netflix');
    expect(names).not.toContain('Spotify');
  });

  it('is empty without paydays', () => {
    expect(buildPlanner([loan, water], data([loan, water]), c, TODAY, 3).plans).toEqual([]);
  });
});

// ---------- cash forecast ----------

describe('buildForecast', () => {
  const c = ctx([account(1, 'debit', 10000_00), account(2, 'debit', 50000_00), account(3, 'credit', -2000_00)]);
  const payday = item('income', { id: 1, name: 'Payday', dueDay: 8, weekendShift: 'before', amountCents: 54000_00, accountId: 1 });
  const goal = item('savings', { id: 2, name: 'Emergency fund', accountId: 2, dueDay: 23, amountCents: 5000_00, payFromAccountId: 1, startDate: '2026-10-24' });
  const power = item('bill', { id: 3, name: 'Power', dueDay: 30, amountCents: 4000_00, startDate: '2026-10-01' });
  const rent = item('bill', { id: 4, name: 'Rent', dueDay: 6, amountCents: 70000_00, payFromAccountId: 1, startDate: '2026-11-01' });
  const onCard = item('bill', { id: 5, name: 'On card', dueDay: 1, amountCents: 1000_00, payFromAccountId: 3, startDate: '2026-11-01' });
  const fromSavings = item('bill', { id: 6, name: 'From savings', dueDay: 2, amountCents: 1000_00, payFromAccountId: 2, startDate: '2026-11-01' });
  const late = item('bill', { id: 7, name: 'Late', dueDay: 20, amountCents: 2000_00, startDate: '2026-10-01' });
  const items = [payday, goal, power, rent, onCard, fromSavings, late];
  const run = (payments: SchedulePayment[] = [], extra: ScheduleItem[] = []) =>
    buildForecast([...items, ...extra], data([...items, ...extra], payments), c, TODAY, 10);
  const timeline = (f: ReturnType<typeof buildForecast>) =>
    f.events.map((e) => [e.date, e.item.name, e.kind === 'in' ? e.amountCents : -e.amountCents, e.balanceAfter, e.shortCents]);

  it('projects cash day by day: overdue today, income first on a shared day, shortfalls flagged', () => {
    const f = run();
    expect(f.startCents).toBe(10000_00); // the savings-goal account and the card are left out
    expect(f.cashAccounts.map((a) => a.id)).toEqual([1]);
    expect(f.setAside.map((a) => a.id)).toEqual([2]);
    expect(timeline(f)).toEqual([
      ['2026-10-28', 'Late', -2000_00, 8000_00, 0], // due Oct 20, comes off today
      ['2026-10-30', 'Power', -4000_00, 4000_00, 0],
      ['2026-11-06', 'Payday', 54000_00, 58000_00, 0], // the 8th is a Sunday
      ['2026-11-06', 'Rent', -70000_00, -12000_00, 12000_00],
    ]);
    expect(f.events[0].overdue).toBe(true);
    expect(f.shortBy).toEqual(new Map([[occurrenceKey(4, '2026-11-06'), 12000_00]]));
    expect(f.lowest).toEqual({ date: '2026-11-06', balanceCents: -12000_00 });
    expect(f.endCents).toBe(-12000_00);
    expect(f.days).toHaveLength(11);
    expect(f.days[0]).toMatchObject({ date: '2026-10-28', balanceCents: 8000_00 });
  });

  it('takes off only what is still unpaid, and skips logged salary and past allowance weeks', () => {
    const groceries = item('allowance', { id: 8, name: 'Groceries', weekDay: 6, amountCents: 3000_00, startDate: '2026-10-01' });
    const f = run([paid(power, '2026-10-30', 1000_00), paid(rent, '2026-11-06', 70000_00), paid(payday, '2026-11-08', 54000_00)], [groceries]);
    expect(timeline(f).map(([date, name, amount]) => [date, name, amount])).toEqual([
      ['2026-10-28', 'Late', -2000_00],
      ['2026-10-30', 'Power', -3000_00],
      ['2026-10-31', 'Groceries', -3000_00], // Oct 24 lapsed: already spent, not deducted again
      ['2026-11-07', 'Groceries', -3000_00],
    ]);
  });

  it('ignores salary paid into an account it does not count as cash', () => {
    const intoSavings = { ...payday, accountId: 2 };
    const all = [intoSavings, goal, rent];
    const f = buildForecast(all, data(all), c, TODAY, 10);
    expect(f.events.map((e) => e.item.name)).toEqual(['Rent']);
  });

  it('counts only the uncovered part of a payment as short', () => {
    const bill = item('bill', { id: 9, name: 'Bill', dueDay: 30, amountCents: 500_00, startDate: '2026-10-01' });
    const short = (balanceCents: number) =>
      buildForecast([bill], data([bill]), ctx([account(1, 'debit', balanceCents)]), TODAY, 5).events[0].shortCents;
    expect(short(300_00)).toBe(200_00);
    expect(short(-1000_00)).toBe(500_00); // already overdrawn: all of it
    expect(short(500_00)).toBe(0);
  });
});

describe('shortfallHelp', () => {
  const payday = item('income', { id: 1, name: 'Payday', dueDay: 8, weekendShift: 'before', amountCents: 54000_00, accountId: 1 });
  const goal = item('savings', { id: 2, name: 'Emergency fund', accountId: 2, dueDay: 23, amountCents: 5000_00, payFromAccountId: 1, startDate: '2026-12-01' });
  const rent = item('bill', { id: 4, name: 'Rent', dueDay: 30, amountCents: 20000_00, payFromAccountId: 3, startDate: '2026-10-01' });
  const items = [payday, goal, rent];
  const accounts = (savings: number) => [
    account(1, 'debit', 7500_00, { name: 'Bank' }),
    account(2, 'debit', savings, { name: 'Savings' }),
    account(3, 'debit', 500_00, { name: 'Wallet' }),
    account(4, 'debit', 0, { name: 'Old wallet', archivedAt: '2026-01-01 00:00:00' }),
  ];
  const run = (c: ScheduleContext, list = items, days = 12) => {
    const f = buildForecast(list, data(list), c, TODAY, days);
    return { f, help: shortfallHelp(f, c) };
  };

  it('offers the savings account and paying what is on hand', () => {
    const c = ctx(accounts(50000_00));
    const { help } = run(c);
    // 8,000 cash (Bank + Wallet), 20,000 rent on Oct 30: 12,000 short.
    expect(help.map((h) => [h.event.item.name, h.event.date, h.event.shortCents, h.needCents])).toEqual([
      ['Rent', '2026-10-30', 12000_00, 12000_00],
    ]);
    expect(help[0].fixes).toEqual([
      { kind: 'move', from: c.accounts[1], to: c.accounts[2], amountCents: 12000_00, covers: true }, // into the pay-from account
      { kind: 'partial', amountCents: 8000_00, restCents: 12000_00, nextPayday: '2026-11-06' },
    ]);
  });

  it('needs the earlier shortfalls covered too, and falls back to the fullest cash account', () => {
    const power = item('bill', { id: 5, name: 'Power', dueDay: 2, amountCents: 3000_00, startDate: '2026-11-01' });
    const noPayFrom = { ...rent, payFromAccountId: null };
    const c = ctx(accounts(50000_00));
    const { help } = run(c, [goal, noPayFrom, power]);
    // After rent the balance is -12,000, so power needs its 3,000 plus that.
    expect(help.map((h) => [h.event.item.name, h.event.shortCents, h.needCents])).toEqual([
      ['Rent', 12000_00, 12000_00],
      ['Power', 3000_00, 15000_00],
    ]);
    expect(help[1].fixes).toEqual([{ kind: 'move', from: c.accounts[1], to: c.accounts[0], amountCents: 15000_00, covers: true }]);
  });

  it('offers everything in a savings account that falls short only once', () => {
    const power = item('bill', { id: 5, name: 'Power', dueDay: 2, amountCents: 3000_00, startDate: '2026-11-01' });
    const c = ctx(accounts(5000_00));
    const { help } = run(c, [goal, rent, power]);
    expect(help[0].fixes[0]).toEqual({ kind: 'move', from: c.accounts[1], to: c.accounts[2], amountCents: 5000_00, covers: false });
    expect(help[1].fixes).toEqual([]);
  });

  it('has nothing to offer with empty savings and no cash', () => {
    const c = ctx([account(1, 'debit', -100_00), account(2, 'debit', 0), account(3, 'debit', 0)]);
    const { help } = run(c);
    expect(help.map((h) => [h.needCents, h.fixes])).toEqual([[20100_00, []]]);
  });

  it('never offers an early payment for a subscription, which charges itself', () => {
    const subs = [subscription(1, { name: 'Netflix', accountId: 3, amountCents: 9000_00, nextDate: '2026-10-30' })];
    const c = ctx(accounts(50000_00), subs);
    const { help } = run(c, withSubscriptions([payday, goal], subs), 5);
    expect([help[0].event.item.name, help[0].event.shortCents]).toEqual(['Netflix', 1000_00]);
    expect(help[0].fixes).toEqual([{ kind: 'move', from: c.accounts[1], to: c.accounts[2], amountCents: 1000_00, covers: true }]);
  });
});

// ---------- calendar ----------

describe('buildCalendar', () => {
  const payday = item('income', { id: 1, name: 'Payday', dueDay: 8, weekendShift: 'before', amountCents: 54000_00, accountId: 1 });
  const loan = item('loan', { id: 2, name: 'Loan', accountId: 10, amountCents: 3000_00, startDate: '2026-11-01' });
  const power = item('bill', { id: 3, name: 'Power', dueDay: 30, amountCents: 4000_00, startDate: '2026-10-01' });
  const water = item('bill', { id: 4, name: 'Water', dueDay: 20, amountCents: 500_00, startDate: '2026-10-01' });
  const groceries = item('allowance', { id: 5, name: 'Groceries', weekDay: 6, amountCents: 3000_00, startDate: '2026-10-01' });
  const subs = [
    subscription(1, { name: 'Netflix', accountId: 1, nextDate: '2026-11-15' }),
    subscription(2, { name: 'Spotify', accountId: 3, nextDate: '2026-11-16' }),
  ];
  const items = withSubscriptions([payday, loan, power, water, groceries], subs);
  const c = ctx([account(1, 'debit', 0), account(3, 'credit', 0), account(10, 'loan', -9000_00, { dueDay: 5 })], subs);
  const d = data(items, [paid(loan, '2026-11-05', 3000_00)]);
  const states = (days: ReturnType<typeof buildCalendar>, date: string) =>
    days.find((x) => x.date === date)?.entries.map((e) => `${e.occurrence.item.name}:${e.state}`);

  it('lays out whole Sunday-first weeks', () => {
    const nov = buildCalendar('2026-11', items, d, c, TODAY, new Map());
    expect([nov[0].date, nov[nov.length - 1].date, nov.length]).toEqual(['2026-11-01', '2026-12-05', 35]);
    expect(nov.filter((x) => x.inMonth)).toHaveLength(30);
    const oct = buildCalendar('2026-10', items, d, c, TODAY, new Map());
    expect([oct[0].date, oct[oct.length - 1].date]).toEqual(['2026-09-27', '2026-10-31']);
  });

  it('puts paydays on their expected date and gives each due date one state', () => {
    const shortBy = new Map([[occurrenceKey(3, '2026-11-30'), 1500_00]]);
    const nov = buildCalendar('2026-11', items, d, c, TODAY, shortBy);
    expect(nov.find((x) => x.date === '2026-11-06')?.paydays.map((p) => p.payday.dueDate)).toEqual(['2026-11-08']);
    expect(nov.find((x) => x.date === '2026-11-08')?.paydays).toEqual([]);
    expect(states(nov, '2026-11-05')).toEqual(['Loan:paid']);
    expect(states(nov, '2026-11-15')).toEqual(['Netflix:auto']);
    expect(states(nov, '2026-11-16')).toEqual([]); // charged to a card
    expect(states(nov, '2026-11-20')).toEqual(['Water:upcoming']);
    expect(states(nov, '2026-11-30')).toEqual(['Power:atrisk']);
    expect(nov.find((x) => x.date === '2026-11-30')?.entries[0].shortCents).toBe(1500_00);
  });

  it('shows past due dates as overdue (even when also short) and past allowance weeks as past', () => {
    const shortBy = new Map([[occurrenceKey(4, '2026-10-20'), 500_00]]);
    const oct = buildCalendar('2026-10', items, d, c, TODAY, shortBy);
    expect(states(oct, '2026-10-20')).toEqual(['Water:overdue']);
    expect(states(oct, '2026-10-24')).toEqual(['Groceries:past']);
    expect(states(oct, '2026-10-31')).toEqual(['Groceries:upcoming']);
  });

  it('keeps a partly paid date overdue once it is past due, even when also short', () => {
    const part = data(items, [paid(water, '2026-10-20', 200_00), paid(loan, '2026-11-05', 1000_00)]);
    const shortBy = new Map([
      [occurrenceKey(4, '2026-10-20'), 300_00],
      [occurrenceKey(2, '2026-11-05'), 2000_00],
    ]);
    expect(states(buildCalendar('2026-10', items, part, c, TODAY, shortBy), '2026-10-20')).toEqual(['Water:overdue']);
    // Not due yet: a partial payment plus a shortfall is still only at risk.
    expect(states(buildCalendar('2026-11', items, part, c, TODAY, shortBy), '2026-11-05')).toEqual(['Loan:atrisk']);
  });
});

describe('isPastDue', () => {
  const water = item('bill', { id: 4, name: 'Water', dueDay: 20, amountCents: 500_00, startDate: '2026-10-01' });
  const occ = (dueDate: string) => ({ item: water, dueDate, amountCents: 500_00 }) as ItemOccurrence;
  const st = (d: ScheduleData, dueDate: string) => dueStatuses([occ(dueDate)], d, TODAY).get(occurrenceKey(4, dueDate));

  it('counts unpaid and partly paid dates before today, nothing else', () => {
    const d = data([water], [paid(water, '2026-09-20', 200_00), paid(water, '2026-10-20', 500_00)]);
    expect(isPastDue(occ('2026-08-20'), st(d, '2026-08-20'), TODAY)).toBe(true); // unpaid
    expect(isPastDue(occ('2026-09-20'), st(d, '2026-09-20'), TODAY)).toBe(true); // ₱300 left
    expect(isPastDue(occ('2026-10-20'), st(d, '2026-10-20'), TODAY)).toBe(false); // paid
    const partToday = data([water], [paid(water, TODAY, 100_00)]);
    expect(isPastDue(occ(TODAY), st(partToday, TODAY), TODAY)).toBe(false); // due today, not late yet
  });
});

// ---------- debt payoff ----------

describe('buildDebtPlan', () => {
  const carAccount = account(10, 'loan', -10000_00, { name: 'Car', dueDay: 5 });
  const cardAccount = account(11, 'credit', -2000_00, { name: 'Card', dueDay: 20 });
  const otherLoan = account(12, 'loan', -5000_00, { name: 'Other loan', dueDay: 1 });
  const car = item('loan', { id: 1, name: 'Car', accountId: 10, amountCents: 3000_00, startDate: '2026-10-01' });
  const card = item('card', { id: 2, name: 'Card', accountId: 11, amountCents: 1000_00, startDate: '2026-10-01' });
  const items = [car, card];
  const accounts = [account(1, 'debit', 100000_00), carAccount, cardAccount, otherLoan];
  const c = ctx(accounts);
  const october = [paid(car, '2026-10-05', 3000_00), paid(card, '2026-10-20', 1000_00)];
  const line = (plan: ReturnType<typeof buildDebtPlan>, id: number) => plan.debts.find((d) => d.account.id === id);

  it('walks each balance down its installments to a payoff date and a debt-free date', () => {
    const plan = buildDebtPlan(items, data(items, october), c, TODAY);
    expect(plan.debts.map((d) => d.account.id)).toEqual([10, 11, 12]); // owed loans and cards only
    expect(line(plan, 10)).toMatchObject({ owedCents: 10000_00, paymentsLeft: 4, lastPaymentCents: 1000_00, payoffDate: '2027-02-05', leftoverCents: 0 });
    expect(line(plan, 11)).toMatchObject({ paymentsLeft: 2, payoffDate: '2026-12-20' });
    // Not on the schedule: listed, but no payoff date and left out of the debt-free date.
    expect(line(plan, 12)).toMatchObject({ item: null, owedCents: 5000_00, payoffDate: null });
    expect(plan.owedCents).toBe(17000_00);
    expect(plan.debtFreeDate).toBe('2027-02-05');
    expect(plan.points.map((p) => [p.date, p.totalCents])).toEqual([
      [TODAY, 12000_00],
      ['2026-11-05', 9000_00],
      ['2026-11-20', 8000_00],
      ['2026-12-05', 5000_00],
      ['2026-12-20', 4000_00],
      ['2027-01-05', 1000_00],
      ['2027-02-05', 0],
    ]);
  });

  it('answers "what if I pay extra this month" by shortening the term', () => {
    const extra = buildDebtPlan(items, data(items, october), c, TODAY, { accountId: 10, amountCents: 3000_00 });
    expect(line(extra, 10)).toMatchObject({ owedCents: 7000_00, paymentsLeft: 3, payoffDate: '2027-01-05' });
    expect(extra.debtFreeDate).toBe('2027-01-05');
    const clears = buildDebtPlan(items, data(items, october), c, TODAY, { accountId: 10, amountCents: 20000_00 });
    expect(line(clears, 10)).toMatchObject({ owedCents: 0, paymentsLeft: 0, payoffDate: TODAY });
    expect(clears.debtFreeDate).toBe('2026-12-20'); // now the card decides it
  });

  it('pays an overdue installment today and a partly paid one its remainder', () => {
    const overdue = buildDebtPlan(items, data(items), c, TODAY);
    expect(overdue.points[1]).toMatchObject({ date: TODAY, totalCents: 8000_00 });
    expect(line(overdue, 10)?.payoffDate).toBe('2027-01-05');
    // ₱1,000 already paid toward Nov 5 (the balance reflects it): ₱2,000 left that day.
    const partial = buildDebtPlan(
      items,
      data(items, [...october, paid(car, '2026-11-05', 1000_00)]),
      ctx([accounts[0], { ...carAccount, balanceCents: -9000_00 }, cardAccount, otherLoan]),
      TODAY
    );
    expect(partial.points.find((p) => p.date === '2026-11-05')?.payments).toEqual([{ name: 'Car', amountCents: 2000_00 }]);
    expect(line(partial, 10)).toMatchObject({ paymentsLeft: 4, lastPaymentCents: 1000_00, payoffDate: '2027-02-05' });
  });

  it("has no debt-free date when a schedule ends before the balance does", () => {
    const short = { ...car, endDate: '2026-12-05' };
    const plan = buildDebtPlan([short, card], data([short, card], october), c, TODAY);
    expect(line(plan, 10)).toMatchObject({ paymentsLeft: 2, payoffDate: null, leftoverCents: 4000_00 });
    expect(plan.debtFreeDate).toBeNull();
  });

  it('settles a rounding remainder under one unit on the last payment', () => {
    // 3 × ₱3,000.00 left against ₱9,000.04 owed: the last payment becomes ₱3,000.04.
    const short = { ...car, endDate: '2027-01-05' };
    const dust = ctx([accounts[0], { ...carAccount, balanceCents: -9000_04 }, cardAccount]);
    const plan = buildDebtPlan([short, card], data([short, card], october), dust, TODAY);
    expect(line(plan, 10)).toMatchObject({ paymentsLeft: 3, lastPaymentCents: 3000_04, payoffDate: '2027-01-05', leftoverCents: 0 });
    expect(plan.debtFreeDate).toBe('2027-01-05');
    expect(plan.points.find((p) => p.date === '2027-01-05')).toMatchObject({ totalCents: 0, payments: [{ name: 'Car', amountCents: 3000_04 }] });
    // A full unit or more is a real gap, not rounding.
    const gap = ctx([accounts[0], { ...carAccount, balanceCents: -9001_00 }, cardAccount]);
    const unfinished = buildDebtPlan([short, card], data([short, card], october), gap, TODAY);
    expect(line(unfinished, 10)).toMatchObject({ lastPaymentCents: 3000_00, payoffDate: null, leftoverCents: 1_00 });
    expect(unfinished.debtFreeDate).toBeNull();
  });

  it('treats a paused item as not scheduled, and nothing owed as no plan', () => {
    const paused = buildDebtPlan([{ ...car, active: false }, card], data(items, october), c, TODAY);
    expect(line(paused, 10)?.item).toBeNull();
    const none = buildDebtPlan(items, data(items), ctx([account(1, 'debit', 500_00)]), TODAY);
    expect([none.debts, none.debtFreeDate]).toEqual([[], null]);
  });
});

// ---------- savings goals ----------

describe('buildGoals', () => {
  const efAccount = account(49, 'debit', 46841_00, { name: 'Emergency Fund' });
  const houseAccount = account(129, 'debit', 12500_00, { name: 'House Fund' });
  const emergency = item('savings', {
    id: 1,
    name: 'Emergency fund',
    accountId: 49,
    dueDay: 23,
    amountCents: 5000_00,
    goalCents: 180000_00,
    goalMilestones: [10000_00, 30000_00, 60000_00],
    startDate: '2026-10-01',
  });
  const house = item('savings', {
    id: 2,
    name: 'House fund',
    accountId: 129,
    dueDay: 8,
    amountCents: 8000_00,
    goalCents: 1000000_00,
    goalMilestones: [100000_00, 500000_00],
    startDate: TODAY,
  });
  const c = ctx([efAccount, houseAccount]);
  const contributions = [paid(emergency, '2026-10-23', 5000_00), paid(emergency, '2026-11-23', 5000_00)];
  const goal = (goals: ReturnType<typeof buildGoals>, id: number) => goals.find((g) => g.item.id === id);
  const checkpoints = (goals: ReturnType<typeof buildGoals>, id: number) =>
    goal(goals, id)?.checkpoints.map((x) => [x.cents, x.reached, x.eta]);

  it("tracks saved vs milestones and dates each one from the scheduled contributions", () => {
    const goals = buildGoals([emergency, house], data([emergency, house], contributions), c, TODAY);
    // ₱46,841 saved, Oct and Nov already paid: +₱5,000 on Dec 23, Jan 23, Feb 23 → ₱61,841.
    expect(checkpoints(goals, 1)).toEqual([
      [10000_00, true, null],
      [30000_00, true, null],
      [60000_00, false, '2027-02-23'],
      [180000_00, false, '2029-02-23'],
    ]);
    expect(goal(goals, 1)).toMatchObject({ savedCents: 46841_00, goalCents: 180000_00, sharedWith: [] });
    expect(goal(goals, 1)?.next).toMatchObject({ cents: 60000_00, isGoal: false });
    expect(goal(goals, 1)?.checkpoints[3].isGoal).toBe(true);
    // ₱12,500 + ₱8,000 on the 8th from Nov 8: 11th, 61st and 124th contributions.
    expect(checkpoints(goals, 2)).toEqual([
      [100000_00, false, '2027-09-08'],
      [500000_00, false, '2031-11-08'],
      [1000000_00, false, '2037-02-08'],
    ]);
  });

  it('counts an overdue contribution as made today, and notes goals sharing an account', () => {
    const fund = item('savings', { id: 3, name: 'Fund', accountId: 50, dueDay: 23, amountCents: 5000_00, goalCents: 20000_00, goalMilestones: [10000_00], startDate: '2026-10-01' });
    const car = item('savings', { id: 4, name: 'Car fund', accountId: 50, dueDay: 1, amountCents: 1000_00, startDate: '2026-11-01' });
    const goals = buildGoals([fund, car], data([fund, car]), ctx([account(50, 'debit', 9000_00)]), TODAY);
    expect(checkpoints(goals, 3)).toEqual([
      [10000_00, false, TODAY], // Oct 23 unpaid → counted now
      [20000_00, false, '2026-12-23'],
    ]);
    expect(goal(goals, 3)?.sharedWith).toEqual(['Car fund']);
    expect(goal(goals, 4)?.sharedWith).toEqual(['Fund']);
  });

  it('handles paused goals, missing or overdrawn accounts, no goal, and contributions that stop', () => {
    const paused = buildGoals([{ ...emergency, active: false }], data([emergency], contributions), c, TODAY);
    expect(goal(paused, 1)?.savedCents).toBe(46841_00);
    expect(goal(paused, 1)?.checkpoints.map((x) => x.eta)).toEqual([null, null, null, null]);

    const missing = buildGoals([{ ...emergency, accountId: 999 }], data([emergency]), c, TODAY);
    expect(goal(missing, 1)).toMatchObject({ account: undefined, savedCents: 0 });
    const overdrawn = buildGoals([emergency], data([emergency]), ctx([{ ...efAccount, balanceCents: -500_00 }]), TODAY);
    expect(goal(overdrawn, 1)?.savedCents).toBe(0);

    const noGoal = buildGoals([{ ...emergency, goalCents: null, goalMilestones: [] }], data([emergency]), c, TODAY);
    expect(goal(noGoal, 1)).toMatchObject({ checkpoints: [], next: null });

    const ending = buildGoals([{ ...emergency, endDate: '2026-12-31' }], data([emergency], contributions), c, TODAY);
    expect(goal(ending, 1)?.next).toMatchObject({ cents: 60000_00, eta: null }); // ₱51,841 is as far as it gets
  });

  it('lists a milestone equal to the goal once, as the goal', () => {
    const goals = buildGoals([{ ...emergency, goalCents: 60000_00, goalMilestones: [30000_00, 60000_00] }], data([emergency], contributions), c, TODAY);
    expect(goal(goals, 1)?.checkpoints.map((x) => [x.cents, x.isGoal])).toEqual([
      [30000_00, false],
      [60000_00, true],
    ]);
  });
});

// ---------- reminders ----------

describe('buildReminders', () => {
  const base = { amountCents: 1000_00, startDate: '2026-10-01' };
  const items = [
    item('income', { id: 1, name: 'Payday today', dueDay: 28, accountId: 1, ...base }),
    item('income', { id: 2, name: 'Payday 2 days ago', dueDay: 26, accountId: 1, ...base }),
    item('income', { id: 3, name: 'Payday 4 days ago', dueDay: 24, accountId: 1, ...base }),
    item('income', { id: 4, name: 'Payday received', dueDay: 27, accountId: 1, ...base }),
    item('loan', { id: 5, name: 'Loan due today', accountId: 10, ...base }),
    item('bill', { id: 6, name: 'Bill overdue', dueDay: 20, ...base }),
    item('bill', { id: 7, name: 'Bill partial', dueDay: 30, ...base }),
    item('bill', { id: 8, name: 'Bill paid', dueDay: 29, ...base }),
    item('bill', { id: 9, name: 'Bill in 4 days', dueDay: 1, ...base, startDate: '2026-10-02' }),
    item('allowance', { id: 10, name: 'Allowance Monday', weekDay: 1, ...base }),
    item('allowance', { id: 11, name: 'Allowance Friday', weekDay: 5, ...base, startDate: '2026-10-29' }),
    item('bill', { id: 12, name: 'Bill before start', dueDay: 25, ...base, startDate: '2026-10-26' }),
  ];
  const subs = [
    subscription(1, { name: 'Sub on debit', amountCents: 549_00, accountId: 1, nextDate: '2026-10-30' }),
    subscription(2, { name: 'Sub on card', amountCents: 299_00, accountId: 11, nextDate: '2026-10-29' }),
  ];
  const c = ctx([account(1, 'debit', 5000_00), account(10, 'loan', -50000_00, { dueDay: 28 }), account(11, 'credit', -100_00)], subs);
  const payments = [
    paid(items[3], '2026-10-27', 1000_00),
    paid(items[6], '2026-10-30', 400_00),
    paid(items[7], '2026-10-29', 1000_00),
  ];
  const run = (today = TODAY, extraActivity: ScheduleActivity[] = []) =>
    buildReminders(withSubscriptions(items, subs), data(items, payments, extraActivity), c, today);
  const describeAll = (list: ReturnType<typeof buildReminders>) =>
    list.map((r) => [r.stage, r.date, r.kind === 'due' ? r.occurrence.item.name : r.payday.item.name]);

  it('lists what needs attention, most urgent first, and leaves out what does not', () => {
    expect(describeAll(run())).toEqual([
      ['overdue', '2026-10-20', 'Bill overdue'],
      ['unlogged', '2026-10-26', 'Payday 2 days ago'],
      ['today', '2026-10-28', 'Payday today'], // income before outflows on the same day
      ['today', '2026-10-28', 'Loan due today'],
      ['soon', '2026-10-30', 'Allowance Friday'],
      ['soon', '2026-10-30', 'Bill partial'],
      ['soon', '2026-10-30', 'Sub on debit'],
    ]);
    // Left out: a payday 4 days back or already received, a paid bill, one 4 days away, a past
    // allowance week, a date before the item started, and a subscription charged to a card.
    const partial = run().find((r) => r.kind === 'due' && r.occurrence.item.id === 7);
    expect(partial?.kind === 'due' && partial.status.remainingCents).toBe(600_00);
  });

  it('gives each stage its own key, so a seen reminder comes back when due and when overdue', () => {
    const keyOn = (today: string) => run(today).find((r) => r.kind === 'due' && r.occurrence.item.id === 6 && r.date === '2026-11-20')?.key;
    expect(keyOn('2026-11-17')).toBe('soon|6|2026-11-20');
    expect(keyOn('2026-11-20')).toBe('today|6|2026-11-20');
    expect(keyOn('2026-11-21')).toBe('overdue|6|2026-11-20');
    expect(keyOn('2026-11-16')).toBeUndefined(); // 4 days ahead: not yet
    expect(run().find((r) => r.kind === 'payday' && r.payday.item.id === 1)?.key).toBe('payday-today|1|2026-10-28');
  });

  it('drops a reminder once it is paid, wherever it was paid', () => {
    // Just today's payday and loan (an earlier unlogged payday would claim the salary first).
    const few = [items[0], items[4]];
    const names = (activity: ScheduleActivity[]) =>
      describeAll(buildReminders(few, data(few, [], activity), c, TODAY)).map(([, , name]) => name);
    expect(names([])).toEqual(['Payday today', 'Loan due today']);
    expect(names([transferIn(10, TODAY, 1000_00)])).toEqual(['Payday today']); // paid on the Accounts page
    expect(names([tx('income', { accountId: 1, date: TODAY, amountCents: 1000_00 })])).toEqual(['Loan due today']);
  });
});

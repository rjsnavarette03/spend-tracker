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
import { buildReminders, withSubscriptions } from './schedule';
import type { Reminder } from './schedule';

// Golden cases shared with the PHP port of the reminder rules
// (server/api/app/lib/reminders.php), which builds the reminder emails. Each
// case is saved to test/fixtures/reminders/<name>.json: its inputs in the
// API's own shapes, plus the reminders this code produces from them.
// test/reminders-parity.php runs the PHP on the same inputs and must get the
// same list, so an email always says what the bell says.
//
// If a change to the reminders is intended, rewrite the files with
// `npx vitest run -u`, then update the PHP until `npm run test:php` passes.

interface GoldenCase {
  name: string;
  about: string;
  today: string;
  accounts: Account[];
  subscriptions: Subscription[];
  schedule: ScheduleData;
  expectKeys: string[]; // checked by hand, so a regenerated file can't hide a wrong answer
}

// ---------- builders (every id explicit: the files are read by PHP too) ----------

function item(id: number, kind: ScheduleKind, name: string, over: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id,
    name,
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

function account(id: number, name: string, type: AccountType, balanceCents: number, over: Partial<Account> = {}): Account {
  return {
    id,
    name,
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

function subscription(id: number, name: string, over: Partial<Subscription>): Subscription {
  return {
    id,
    name,
    amountCents: 0,
    accountId: 1,
    accountName: null,
    accountColor: null,
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    cycle: 'monthly',
    billDay: null,
    intervalDays: null,
    nextDate: '2026-01-01',
    active: true,
    ...over,
  };
}

/** Paid through the Schedule; a payment with a transferId is a transfer, otherwise a transaction. */
function payment(
  id: number,
  itemId: number,
  dueDate: string,
  amountCents: number,
  ledger: { transferId?: number; transactionId?: number; paidDate?: string }
): SchedulePayment {
  return {
    id,
    itemId,
    dueDate,
    transferId: ledger.transferId ?? null,
    transactionId: ledger.transactionId ?? null,
    amountCents,
    paidDate: ledger.paidDate ?? dueDate,
  };
}

/** A transfer INTO an account (e.g. Accounts → Pay on a loan). */
function transferIn(id: number, accountId: number, date: string, amountCents: number): ScheduleActivity {
  return { source: 'transfer', id, type: 'transfer', accountId, categoryId: null, date, amountCents, note: '' };
}

function tx(
  id: number,
  type: 'income' | 'expense',
  date: string,
  amountCents: number,
  over: { accountId?: number | null; categoryId?: number | null; note?: string } = {}
): ScheduleActivity {
  return {
    source: 'transaction',
    id,
    type,
    accountId: over.accountId ?? 1,
    categoryId: over.categoryId ?? null,
    date,
    amountCents,
    note: over.note ?? '',
  };
}

// ---------- cases ----------

const CASES: GoldenCase[] = [
  {
    name: 'bell-scenario',
    about:
      'The in-app bell test scenario: unlogged and received paydays, a loan due today, overdue / partial / paid bills, ' +
      'past allowance weeks (lapsed, never reminded), a date before the item started, and subscriptions on a debit ' +
      'account (reminded) and on a credit card (not: the card payment covers it).',
    today: '2026-10-28',
    accounts: [
      account(1, 'GCash', 'debit', 5000_00),
      account(10, 'Car loan', 'loan', -50000_00, { dueDay: 28 }),
      account(11, 'BPI card', 'credit', -100_00),
    ],
    subscriptions: [
      subscription(1, 'Sub on debit', { amountCents: 549_00, accountId: 1, billDay: 30, nextDate: '2026-10-30' }),
      subscription(2, 'Sub on card', { amountCents: 299_00, accountId: 11, billDay: 29, nextDate: '2026-10-29' }),
    ],
    schedule: {
      items: [
        item(1, 'income', 'Payday today', { dueDay: 28, accountId: 1, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(2, 'income', 'Payday 2 days ago', { dueDay: 26, accountId: 1, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(3, 'income', 'Payday 4 days ago', { dueDay: 24, accountId: 1, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(4, 'income', 'Payday received', { dueDay: 27, accountId: 1, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(5, 'loan', 'Loan due today', { accountId: 10, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(6, 'bill', 'Bill overdue', { dueDay: 20, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(7, 'bill', 'Bill partial', { dueDay: 30, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(8, 'bill', 'Bill paid', { dueDay: 29, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(9, 'bill', 'Bill in 4 days', { dueDay: 1, amountCents: 1000_00, startDate: '2026-10-02' }),
        item(10, 'allowance', 'Allowance Monday', { weekDay: 1, amountCents: 1000_00, startDate: '2026-10-01' }),
        item(11, 'allowance', 'Allowance Friday', { weekDay: 5, amountCents: 1000_00, startDate: '2026-10-29' }),
        item(12, 'bill', 'Bill before start', { dueDay: 25, amountCents: 1000_00, startDate: '2026-10-26' }),
      ],
      payments: [
        payment(1, 4, '2026-10-27', 1000_00, { transactionId: 9001 }),
        payment(2, 7, '2026-10-30', 400_00, { transactionId: 9002 }),
        payment(3, 8, '2026-10-29', 1000_00, { transactionId: 9003 }),
      ],
      activity: [],
    },
    expectKeys: [
      'overdue|6|2026-10-20',
      'payday-unlogged|2|2026-10-26',
      'payday-today|1|2026-10-28',
      'today|5|2026-10-28',
      'soon|11|2026-10-30',
      'soon|7|2026-10-30',
      'soon|-1|2026-10-30',
    ],
  },
  {
    name: 'paid-elsewhere',
    about:
      'Payments made outside the Schedule. Late loan payments clear the oldest due date first; a payment dated before ' +
      'the item started never counts; a bill with a keyword claims its expenses before a catch-all bill in the same ' +
      'category; a transfer already linked to a Schedule payment is not counted again; an outside card payment can be ' +
      'partial; savings settle by a transfer in; allowances count only Schedule payments.',
    today: '2026-10-28',
    accounts: [
      account(1, 'GCash', 'debit', 20000_00),
      account(2, 'Savings', 'debit', 3000_00),
      account(10, 'Car loan', 'loan', -400000_00, { dueDay: 28 }),
      account(11, 'BPI card', 'credit', -12000_00, { dueDay: 15, dueDay2: 30 }),
    ],
    subscriptions: [],
    schedule: {
      items: [
        item(1, 'loan', 'Car loan', { accountId: 10, amountCents: 8000_00, startDate: '2026-08-01' }),
        item(2, 'bill', 'Utilities', { categoryId: 50, dueDay: 20, amountCents: 1000_00, startDate: '2026-09-01' }),
        item(3, 'bill', 'Meralco', {
          categoryId: 50,
          matchKeyword: 'meralco',
          dueDay: 25,
          amountCents: 2450_00,
          startDate: '2026-09-01',
        }),
        item(4, 'card', 'BPI card', { accountId: 11, amountCents: 5000_00, startDate: '2026-10-01' }),
        item(5, 'savings', 'Emergency fund', { accountId: 2, dueDay: 26, amountCents: 3000_00, startDate: '2026-10-01' }),
        item(6, 'allowance', 'Groceries', { categoryId: 51, weekDay: 4, amountCents: 1500_00, startDate: '2026-10-01' }),
      ],
      payments: [
        payment(1, 4, '2026-10-15', 5000_00, { transferId: 501, paidDate: '2026-10-14' }),
        payment(2, 6, '2026-10-29', 1500_00, { transactionId: 801, paidDate: '2026-10-27' }),
      ],
      activity: [
        transferIn(500, 10, '2026-07-30', 8000_00),
        transferIn(502, 10, '2026-09-30', 8000_00),
        transferIn(503, 10, '2026-10-02', 8000_00),
        transferIn(501, 11, '2026-10-14', 5000_00),
        transferIn(504, 2, '2026-10-26', 3000_00),
        transferIn(505, 11, '2026-10-27', 2000_00),
        tx(701, 'expense', '2026-09-19', 1000_00, { categoryId: 50, note: 'Water bill' }),
        tx(702, 'expense', '2026-09-24', 2450_00, { categoryId: 50, note: 'Meralco Sep' }),
        tx(703, 'expense', '2026-10-24', 2450_00, { categoryId: 50, note: 'MERALCO October' }),
        tx(801, 'expense', '2026-10-27', 1500_00, { categoryId: 51, note: 'Groceries' }),
      ],
    },
    expectKeys: ['overdue|2|2026-10-20', 'today|1|2026-10-28', 'soon|4|2026-10-30'],
  },
  {
    name: 'paydays',
    about:
      'Paydays around a weekend: shifts to the Friday before (into the previous month) and the Monday after, ' +
      'reminded on the expected date and for 3 days after while unlogged. Salary counts when logged or when income ' +
      'lands in the deposit account (and category, if set) from 3 days before to 5 days after; each income counts ' +
      'once, earliest payday first, and income already linked to a logged payday is not reused. Ended, paused and ' +
      'future paydays are left out.',
    today: '2026-11-02',
    accounts: [
      account(1, 'GCash', 'debit', 10000_00),
      account(2, 'BPI', 'debit', 50000_00),
      account(3, 'Maya', 'debit', 2000_00),
    ],
    subscriptions: [],
    schedule: {
      items: [
        item(1, 'income', 'Salary 30th', {
          dueDay: 30,
          weekendShift: 'before',
          accountId: 1,
          categoryId: 60,
          amountCents: 25000_00,
          startDate: '2026-09-01',
        }),
        item(2, 'income', 'Side gig', { dueDay: 1, weekendShift: 'after', accountId: 2, amountCents: 5000_00, startDate: '2026-09-01' }),
        item(3, 'income', 'Allowance from parents', {
          dueDay: 31,
          weekendShift: 'before',
          accountId: 1,
          amountCents: 3000_00,
          startDate: '2026-09-01',
        }),
        item(4, 'income', 'Bonus', { dueDay: 29, accountId: 1, amountCents: 2000_00, startDate: '2026-10-01' }),
        // Expected Sunday the 1st, so it's checked before Side gig (Monday the
        // 2nd) — and would wrongly take Side gig's logged income if allowed.
        item(5, 'income', 'Rental income', { dueDay: 1, accountId: 2, amountCents: 8000_00, startDate: '2026-09-01' }),
        item(6, 'income', 'Old job', {
          dueDay: 1,
          weekendShift: 'after',
          accountId: 3,
          amountCents: 10000_00,
          endDate: '2026-10-01',
        }),
        item(7, 'income', 'Paused payday', { dueDay: 2, accountId: 3, amountCents: 1000_00, active: false }),
        item(8, 'income', 'Upcoming payday', { dueDay: 5, accountId: 3, amountCents: 1000_00 }),
        item(9, 'income', 'Freelance', { dueDay: 1, weekendShift: 'after', accountId: 3, amountCents: 6000_00, startDate: '2026-10-15' }),
        item(10, 'income', 'Commission', {
          dueDay: 1,
          weekendShift: 'before',
          accountId: 3,
          amountCents: 4000_00,
          startDate: '2026-10-15',
        }),
      ],
      payments: [payment(1, 2, '2026-11-01', 5000_00, { transactionId: 701, paidDate: '2026-11-02' })],
      activity: [
        tx(601, 'income', '2026-10-30', 3000_00, { accountId: 1, categoryId: 61, note: 'From Mom' }),
        tx(701, 'income', '2026-11-02', 5000_00, { accountId: 2, note: 'Side gig' }),
      ],
    },
    expectKeys: [
      'payday-unlogged|3|2026-10-31',
      'payday-unlogged|10|2026-11-01',
      'payday-unlogged|1|2026-10-30',
      'payday-unlogged|5|2026-11-01',
      'payday-today|9|2026-11-01',
    ],
  },
  {
    name: 'month-ends',
    about:
      'Short-month clamping: a card due on the 30th and 31st has one due date on Feb 28; rent on the 31st falls on ' +
      'Feb 28; a yearly subscription anchored on Feb 29 bills Feb 28. Also: a loan with two missed installments, a ' +
      'subscription whose next charge date is already past (it reads overdue until it is charged, which is why the ' +
      'reminders job charges due subscriptions first), a card-charged, a paused and an account-less subscription ' +
      '(none reminded), a subscription with its own schedule row, a paused bill, and a loan whose last installment ' +
      'has passed.',
    today: '2027-02-26',
    accounts: [
      account(1, 'GCash', 'debit', 30000_00),
      account(2, 'BPI', 'debit', 10000_00),
      account(11, 'Credit card', 'credit', -2000_00, { dueDay: 30, dueDay2: 31 }),
      account(12, 'Home loan', 'loan', -1000000_00, { dueDay: 1 }),
      account(13, 'Paid-off loan', 'loan', 0, { dueDay: 27 }),
    ],
    subscriptions: [
      subscription(1, 'Domain', { cycle: 'yearly', billDay: 29, nextDate: '2027-02-28', accountId: 1, amountCents: 900_00 }),
      subscription(2, 'Gym', { cycle: 'interval', intervalDays: 14, nextDate: '2027-02-25', accountId: 1, amountCents: 1500_00 }),
      subscription(3, 'Streaming', { billDay: 31, nextDate: '2027-02-28', accountId: 11, amountCents: 549_00 }),
      subscription(4, 'Paused sub', { billDay: 27, nextDate: '2027-02-27', accountId: 1, amountCents: 100_00, active: false }),
      subscription(5, 'Orphan sub', { billDay: 27, nextDate: '2027-02-27', accountId: null, amountCents: 100_00 }),
      subscription(6, 'Music', { billDay: 1, nextDate: '2027-03-01', accountId: 2, amountCents: 199_00 }),
    ],
    schedule: {
      items: [
        item(1, 'card', 'Credit card', { accountId: 11, amountCents: 1000_00, startDate: '2026-12-01' }),
        item(2, 'bill', 'Rent', { dueDay: 31, amountCents: 15000_00, startDate: '2027-01-01' }),
        item(3, 'loan', 'Home loan', { accountId: 12, amountCents: 20000_00, startDate: '2027-01-01' }),
        item(4, 'subscription', 'Music', { subscriptionId: 6 }),
        item(5, 'bill', 'Paused bill', { dueDay: 27, amountCents: 500_00, active: false }),
        item(6, 'loan', 'Paid-off loan', { accountId: 13, amountCents: 3000_00, startDate: '2026-12-01', endDate: '2027-01-27' }),
        item(7, 'allowance', 'Weekly allowance', { weekDay: 0, amountCents: 2000_00, startDate: '2027-02-01' }),
      ],
      payments: [
        payment(1, 1, '2026-12-30', 1000_00, { transferId: 901 }),
        payment(2, 1, '2026-12-31', 1000_00, { transferId: 902 }),
        payment(3, 1, '2027-01-30', 1000_00, { transferId: 903 }),
        payment(4, 1, '2027-01-31', 1000_00, { transferId: 904 }),
        payment(5, 2, '2027-01-31', 15000_00, { transactionId: 905 }),
        payment(6, 6, '2026-12-27', 3000_00, { transferId: 906 }),
        payment(7, 6, '2027-01-27', 3000_00, { transferId: 907 }),
      ],
      activity: [],
    },
    expectKeys: [
      'overdue|3|2027-01-01',
      'overdue|3|2027-02-01',
      'overdue|-2|2027-02-25',
      'soon|1|2027-02-28',
      'soon|-1|2027-02-28',
      'soon|2|2027-02-28',
      'soon|7|2027-02-28',
      'soon|3|2027-03-01',
      'soon|4|2027-03-01',
    ],
  },
  {
    name: 'year-end',
    about:
      'Across the new year: a bill on the 1st and a Saturday allowance land in January, a monthly subscription billed ' +
      'on the 31st, a Sunday payday moved to Monday still unlogged, savings due today, and paydays later this week ' +
      '(not reminded until they arrive).',
    today: '2026-12-30',
    accounts: [account(1, 'GCash', 'debit', 15000_00), account(2, 'Savings', 'debit', 8000_00)],
    subscriptions: [
      subscription(1, 'Cloud storage', { billDay: 31, nextDate: '2026-12-31', accountId: 1, amountCents: 149_00 }),
    ],
    schedule: {
      items: [
        item(1, 'bill', 'Internet', { categoryId: 70, dueDay: 1, amountCents: 1699_00, startDate: '2026-11-01' }),
        item(2, 'income', 'Year-end salary', { dueDay: 31, accountId: 1, amountCents: 30000_00, startDate: '2026-11-01' }),
        item(3, 'income', '13th month', {
          dueDay: 2,
          weekendShift: 'before',
          accountId: 1,
          amountCents: 30000_00,
          startDate: '2026-11-01',
        }),
        item(4, 'income', 'Holiday pay', { dueDay: 27, weekendShift: 'after', accountId: 2, amountCents: 5000_00, startDate: '2026-11-01' }),
        item(5, 'allowance', 'Weekend money', { weekDay: 6, amountCents: 1000_00, startDate: '2026-12-01' }),
        item(6, 'savings', 'Christmas fund', { accountId: 2, dueDay: 30, amountCents: 2000_00, startDate: '2026-11-01' }),
      ],
      payments: [payment(1, 1, '2026-12-01', 1699_00, { transactionId: 801 })],
      activity: [
        transferIn(803, 2, '2026-11-29', 2000_00),
        tx(802, 'expense', '2026-11-01', 1699_00, { categoryId: 70, note: 'PLDT' }),
      ],
    },
    expectKeys: [
      'payday-unlogged|4|2026-12-27',
      'today|6|2026-12-30',
      'soon|-1|2026-12-31',
      'soon|1|2027-01-01',
      'soon|5|2027-01-02',
    ],
  },
  {
    name: 'nothing-due',
    about:
      'A quiet day: the bill and salary are settled, past allowance weeks have lapsed, and the next allowance and ' +
      'subscription charge are more than 3 days away — no reminders, so no email.',
    today: '2026-10-28',
    accounts: [account(1, 'GCash', 'debit', 5000_00)],
    subscriptions: [subscription(1, 'Netflix', { billDay: 15, nextDate: '2026-11-15', accountId: 1, amountCents: 549_00 })],
    schedule: {
      items: [
        item(1, 'bill', 'Water', { dueDay: 15, amountCents: 600_00, startDate: '2026-10-01' }),
        item(2, 'income', 'Salary', { dueDay: 15, accountId: 1, amountCents: 20000_00, startDate: '2026-10-01' }),
        item(3, 'allowance', 'Snacks', { weekDay: 1, amountCents: 500_00, startDate: '2026-10-01' }),
      ],
      payments: [payment(1, 1, '2026-10-15', 600_00, { transactionId: 901 })],
      activity: [tx(902, 'income', '2026-10-15', 20000_00, { accountId: 1, note: 'Salary' })],
    },
    expectKeys: [],
  },
];

/** A reminder in the flat shape the PHP port returns (Reminders::build). */
function flatten(r: Reminder) {
  if (r.kind === 'due') {
    const { occurrence: o, status: s } = r;
    return {
      key: r.key,
      kind: r.kind,
      stage: r.stage,
      date: r.date,
      dueDate: o.dueDate,
      itemId: o.item.id,
      itemKind: o.item.kind,
      name: o.item.name,
      amountCents: o.amountCents,
      paidCents: s.paidCents,
      remainingCents: s.remainingCents,
      state: s.state,
    };
  }
  const { payday: p, status: s } = r;
  return {
    key: r.key,
    kind: r.kind,
    stage: r.stage,
    date: r.date,
    dueDate: p.dueDate,
    itemId: p.item.id,
    itemKind: p.item.kind,
    name: p.item.name,
    amountCents: p.item.amountCents,
    paidCents: s.receivedCents,
    remainingCents: Math.max(0, p.item.amountCents - s.receivedCents),
    state: s.state,
  };
}

describe('reminder golden cases (shared with the PHP port)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const ctx = { accounts: c.accounts, subscriptions: c.subscriptions };
      const expected = buildReminders(withSubscriptions(c.schedule.items, c.subscriptions), c.schedule, ctx, c.today).map(
        flatten
      );
      expect(expected.map((r) => r.key)).toEqual(c.expectKeys);
      const file = {
        about: c.about,
        today: c.today,
        accounts: c.accounts,
        subscriptions: c.subscriptions,
        schedule: c.schedule,
        expected,
      };
      await expect(JSON.stringify(file, null, 2) + '\n').toMatchFileSnapshot(`../test/fixtures/reminders/${c.name}.json`);
    });
  }
});

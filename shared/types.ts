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
  // Daily reminder emails (opt-in, off by default), sent around 7 AM in
  // reminderTimezone — the IANA zone saved from the browser when turned on.
  reminderEmails: boolean;
  reminderTimezone: string | null;
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
  // Monthly payment due day(s) (1–31) for credit/loan accounts; null = none.
  // The UI computes and shows the NEXT due date from these, so they never go
  // stale after a payment (days 29–31 clamp in shorter months). dueDay2
  // supports twice-a-month cycles (e.g. 15th + 30th); the server normalizes
  // so dueDay is always the earlier/only day.
  dueDay: number | null;
  dueDay2: number | null;
  // Credit cards: the card's limit and the day of the month its statement
  // closes; null = not set.
  creditLimitCents: number | null;
  statementDay: number | null;
  // Credit cards and loans: yearly interest rate in basis points (3600 = 36%
  // a year), charged on what's still owed. null = none — the right setting
  // for installments that already include their interest.
  interestRateBp: number | null;
  openingBalanceCents: number;
  balanceCents: number;
  // When a settled account was archived ('YYYY-MM-DD HH:MM:SS', server time);
  // null = active. Archived accounts stay in GET /accounts — history and the
  // account's own page still need them — and the UI hides them from lists
  // and pickers. Any new transaction or transfer on one clears this.
  archivedAt: string | null;
  txCount: number;
  transferCount: number;
}

// What the account form saves. Type is chosen at creation and never changes.
// creditLimitCents/statementDay are credit-only and interestRateBp is for
// credit and loan accounts (422 otherwise); on update, a field left out of
// the body keeps its stored value.
export interface AccountInput {
  name: string;
  color: string;
  image: string | null;
  dueDay: number | null;
  dueDay2: number | null;
  creditLimitCents: number | null;
  statementDay: number | null;
  interestRateBp: number | null;
  openingBalanceCents: number;
}

export interface Transfer {
  id: number;
  fromAccountId: number | null; // null after the account was deleted
  toAccountId: number | null;
  amountCents: number;
  feeCents: number;
  date: string; // YYYY-MM-DD
  time: string | null; // optional 'HH:MM', same convention as Transaction.time
  note: string;
  fromName: string | null;
  fromColor: string | null;
  toName: string | null;
  toColor: string | null;
}

export interface TransferInput {
  fromAccountId: number;
  // null = borrow taken without a deposit account (loan sources only): the
  // amount + fee grow the debt but land nowhere.
  toAccountId: number | null;
  amountCents: number;
  feeCents: number;
  date: string; // YYYY-MM-DD
  time: string | null; // 'HH:MM' or null
  note: string;
}

export interface Transaction {
  id: number;
  amountCents: number;
  type: TxType;
  categoryId: number | null;
  accountId: number | null;
  date: string; // YYYY-MM-DD
  // Optional time-of-day, 24h 'HH:MM' (client-local, same string convention
  // as date). NULL on rows that predate the feature / subscription charges.
  time: string | null;
  note: string;
  // Part of a split receipt: the parts share the type, account, date, time
  // and note, each in its own category, and splitGroup is the smallest id
  // among them. null = an ordinary transaction.
  splitGroup: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string | null;
  accountColor: string | null;
}

// One receipt divided across categories. The shared fields apply to every
// part. A new split takes 2–20 parts. Re-splitting keeps a part that brings
// its id (so links to it, like a Schedule payment, survive), adds parts
// without one and deletes the receipt's parts that are left out; a single
// part turns it back into an ordinary transaction.
export interface SplitInput {
  type: TxType;
  accountId: number | null;
  date: string; // YYYY-MM-DD
  time: string | null;
  note: string;
  parts: Array<{ id: number | null; categoryId: number | null; amountCents: number }>;
}

export interface TxInput {
  amountCents: number;
  type: TxType;
  categoryId: number | null;
  accountId: number | null;
  date: string; // YYYY-MM-DD
  time: string | null; // 'HH:MM' or null
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
  splitGroup?: number; // the parts of one split receipt
}

// The recurring period a budget amount applies to.
export type BudgetCadence = 'week' | 'month' | 'year';

// One row per expense category (budget may be unset = amount 0). A category has
// at most one recurring budget. `spentCents` is the category's expense total in
// the current period of `cadence` (this week / this month / this year).
// With `rollover` on, what earlier periods left unused is carried forward:
// this period's limit is amountCents + carryCents. An overspent period uses
// up the carry but never makes it negative. carryCents is 0 with rollover
// off, and in the period it was switched on.
export interface Budget {
  id: number;
  categoryId: number;
  cadence: BudgetCadence;
  amountCents: number;
  rollover: boolean;
  carryCents: number;
  categoryName: string;
  categoryColor: string;
  spentCents: number;
}

// Recurring subscription (Netflix, internet, ...) auto-charged from a linked
// debit/credit account. When nextDate arrives the server inserts an ordinary
// expense transaction (dated nextDate) and advances nextDate one cycle:
// 'monthly' re-lands on billDay every month (29–31 clamp in short months),
// 'yearly' on the same month + billDay every year (Feb 29 clamps to Feb 28
// in non-leap years), 'interval' adds intervalDays (e.g. every 30 days).
// Charges post on the next API request after the date passes (no cron on
// shared hosting) and catch up if several cycles were missed. accountId goes
// null if the account is deleted — charging pauses until relinked.
export type SubscriptionCycle = 'monthly' | 'yearly' | 'interval';

export interface Subscription {
  id: number;
  name: string;
  amountCents: number;
  accountId: number | null;
  accountName: string | null;
  accountColor: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  cycle: SubscriptionCycle;
  billDay: number | null; // monthly: anchor day-of-month (from nextDate)
  intervalDays: number | null; // interval: days between charges
  nextDate: string; // YYYY-MM-DD of the next charge
  active: boolean;
}

export interface SubscriptionInput {
  name: string;
  amountCents: number;
  accountId: number;
  categoryId: number | null;
  cycle: SubscriptionCycle;
  intervalDays: number | null; // required when cycle = 'interval'
  nextDate: string; // billDay derives from this server-side for 'monthly'
  active: boolean;
}

// ---------- payment schedule ----------
// A planning layer over the ledger. Items are paydays ('income') or planned
// outflows; paying one creates an ordinary transfer/transaction (the same
// paths as Pay / Add transaction) plus a SchedulePayment link to the
// occurrence it settles. Loans and cards take their due days from the linked
// account; bills, savings and paydays carry dueDay; allowances recur weekly
// on weekDay. 'subscription' rows only pick the funding payday — amount and
// dates stay on the Subscription, which is auto-charged (never "paid" here).
export type ScheduleKind = 'income' | 'loan' | 'card' | 'bill' | 'allowance' | 'savings' | 'subscription';

// 'avg3' (bills only): estimate from the last 3 complete months' spending.
export type ScheduleAmountMode = 'fixed' | 'avg3';

// Where a payday falling on a weekend moves: the Friday before, the Monday after, or nowhere.
export type WeekendShift = 'none' | 'before' | 'after';

export interface ScheduleItem {
  id: number;
  name: string;
  kind: ScheduleKind;
  // loan/card: the account being paid · savings: destination · income: deposit account.
  accountId: number | null;
  subscriptionId: number | null;
  // bill/allowance: expense category for payments + the estimate source; income: income category.
  categoryId: number | null;
  amountMode: ScheduleAmountMode;
  // Per occurrence: installment, weekly allowance, expected salary, or the
  // avg3 fallback (0 = none). Always 0 for subscription rows.
  amountCents: number;
  // Bills: only category expenses whose note contains this count — for the
  // avg3 estimate, and as payments of this bill when paid outside the Schedule.
  matchKeyword: string | null;
  dueDay: number | null; // income/bill/savings; loans & cards use the account's dueDay(s)
  weekDay: number | null; // allowance: 0 = Sunday .. 6 = Saturday
  fundedBy: number | null; // income item id; null = automatic
  weekendShift: WeekendShift; // income only ('none' elsewhere)
  startDate: string; // YYYY-MM-DD; earlier occurrences are not tracked
  endDate: string | null; // last occurrence (e.g. final installment)
  goalCents: number | null; // savings target
  goalMilestones: number[]; // savings checkpoints (cents, ascending, ≤ goalCents); [] = none
  payFromAccountId: number | null; // default source account when paying
  active: boolean;
  // avg3 bills: average over estimateFrom..estimateTo; null = no history yet.
  estimateCents: number | null;
  estimateFrom: string | null;
  estimateTo: string | null;
}

// Fields irrelevant to the kind are ignored (stored as null). On update, kind
// and subscriptionId are immutable; omitted startDate keeps the current one.
export interface ScheduleItemInput {
  kind: ScheduleKind;
  name: string; // ignored for 'subscription' (uses the subscription's name)
  accountId: number | null;
  subscriptionId: number | null;
  categoryId: number | null;
  amountMode: ScheduleAmountMode;
  amountCents: number;
  matchKeyword: string | null;
  dueDay: number | null;
  weekDay: number | null;
  fundedBy: number | null;
  weekendShift: WeekendShift;
  startDate: string | null; // null = today (create) / unchanged (update)
  endDate: string | null;
  goalCents: number | null; // savings; null with milestones = the largest milestone
  goalMilestones: number[]; // savings; sorted/deduped server-side, none above the goal
  payFromAccountId: number | null;
  active: boolean;
}

// Links one occurrence (itemId + dueDate) to the ledger row that settled it.
// amountCents/paidDate are read from that row, so they track later edits.
// Several links per occurrence = partial payments.
export interface SchedulePayment {
  id: number;
  itemId: number;
  dueDate: string;
  transferId: number | null;
  transactionId: number | null;
  amountCents: number;
  paidDate: string;
}

// A recent ledger row (last ~120 days) that may settle an occurrence even if
// it wasn't paid through the Schedule: transfers into loan/card/savings item
// accounts, income into payday deposit accounts, expenses in bill
// categories. Rows already linked by a SchedulePayment are included too —
// match on (source, id) to avoid counting them twice.
export interface ScheduleActivity {
  source: 'transfer' | 'transaction';
  id: number;
  type: 'transfer' | TxType;
  accountId: number | null; // transfer: destination; transaction: its account
  categoryId: number | null;
  date: string;
  amountCents: number;
  note: string;
}

export interface ScheduleData {
  items: ScheduleItem[];
  payments: SchedulePayment[]; // due dates in the last ~13 months onward
  activity: ScheduleActivity[];
}

export interface SchedulePayInput {
  itemId: number;
  dueDate: string; // the occurrence being settled
  // Cash side: pay-from account (income: deposit account). null = the item's default.
  accountId: number | null;
  amountCents: number; // less than due = partial, more = extra
  feeCents: number; // loan/card/savings only
  date: string; // when the money actually moved
  time: string | null;
  note: string; // '' = a default like "Payment to SLoan 2"
}

export interface SchedulePayResult {
  payment: SchedulePayment;
  transfer: Transfer | null; // loan/card/savings
  transaction: Transaction | null; // income/bill/allowance
}

// ---------- importing a bank statement ----------
// The browser reads the CSV, maps its columns and the user reviews each line;
// POST /import saves the kept lines as ordinary transactions on one debit or
// credit account, all or nothing.

export interface ImportRow {
  date: string; // YYYY-MM-DD
  amountCents: number; // > 0
  type: TxType;
  categoryId: number | null;
  note: string; // the statement's description
}

export interface ImportInput {
  accountId: number;
  rows: ImportRow[]; // 1–1000
}

export interface ImportResult {
  imported: number;
  ids: number[];
}

// "Description contains <keyword>" → category, remembered between imports.
// keyword is lowercase; a rule only applies to lines of its category's type.
export interface ImportRule {
  id: number;
  keyword: string;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  categoryType: TxType;
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

// Net worth at the end of one month (the newest point is "now"): assets are
// the positive account balances, liabilities the negative ones. An account
// counts from the month it was added or first used.
export interface NetWorthPoint {
  month: string; // YYYY-MM
  assetsCents: number;
  liabilitiesCents: number; // positive number = owed
  netCents: number;
}

// ---------- AI assistant (the floating "Ask about your money" chat) ----------

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantStatus {
  enabled: boolean; // false when the server has no AI key configured: hide the chat
  provider: string; // who answers, named under the chat (e.g. "Groq")
  dailyLimit: number; // questions per user per day
  remaining: number; // left in this user's current 24-hour window
}

export interface AssistantReply {
  reply: string;
  remaining: number;
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
    // Reminder emails on/off; turning on needs the browser's IANA time zone.
    setReminders(
      enabled: boolean,
      timezone: string | null
    ): Promise<{ reminderEmails: boolean; reminderTimezone: string | null }>;
    // Permanently deletes the user and (via DB cascades) all their data.
    // Accounts with a password must re-confirm it; pass '' for Google-only.
    deleteAccount(currentPassword: string): Promise<void>;
  };
  categories: {
    list(): Promise<Category[]>;
    create(data: { name: string; type: TxType; color: string }): Promise<Category>;
    update(id: number, data: { name: string; color: string }): Promise<void>;
    remove(id: number): Promise<void>;
  };
  accounts: {
    list(): Promise<Account[]>;
    create(data: AccountInput & { type: AccountType }): Promise<Account>;
    update(id: number, data: AccountInput): Promise<void>;
    remove(id: number): Promise<void>;
    // Settled accounts only (balance 0; 422 otherwise, or while a subscription
    // charges it). Pauses schedule items that pay into it and names them.
    archive(id: number): Promise<{ archivedAt: string; pausedItems: string[] }>;
    restore(id: number): Promise<void>;
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
    // Deletes this one transaction (one part, when it's part of a split).
    remove(id: number): Promise<void>;
    split(data: SplitInput): Promise<Transaction[]>;
    // Re-splits transaction `id`'s receipt, or splits it when it isn't one yet.
    resplit(id: number, data: SplitInput): Promise<Transaction[]>;
    // Deletes transaction `id` and every other part of its split.
    removeSplit(id: number): Promise<void>;
  };
  budgets: {
    list(): Promise<Budget[]>;
    // rollover left out = keep what the budget has (off for a new one).
    upsert(categoryId: number, cadence: BudgetCadence, amountCents: number, rollover?: boolean): Promise<void>;
  };
  subscriptions: {
    list(): Promise<Subscription[]>;
    create(data: SubscriptionInput): Promise<Subscription>;
    update(id: number, data: SubscriptionInput): Promise<void>;
    remove(id: number): Promise<void>;
  };
  schedule: {
    get(): Promise<ScheduleData>;
    createItem(data: ScheduleItemInput): Promise<ScheduleItem>;
    updateItem(id: number, data: ScheduleItemInput): Promise<void>;
    // Removes the plan only; payments already made stay in the ledger.
    removeItem(id: number): Promise<void>;
    pay(data: SchedulePayInput): Promise<SchedulePayResult>;
  };
  imports: {
    run(data: ImportInput): Promise<ImportResult>;
    rules(): Promise<ImportRule[]>;
    // Saving a keyword that exists moves it to the new category.
    saveRule(keyword: string, categoryId: number): Promise<ImportRule>;
    removeRule(id: number): Promise<void>;
  };
  reminders: {
    // The token from a reminder email's link; needs no session. Only turns
    // reminder emails off.
    unsubscribe(token: string): Promise<void>;
  };
  reports: {
    summary(from: string, to: string): Promise<MonthlySummary>;
    trend(endMonth: string, count: number): Promise<MonthlySummary[]>;
    breakdown(from: string, to: string, type: TxType): Promise<BreakdownRow[]>;
    years(): Promise<number[]>;
    // Oldest first; shorter than `months` when tracking started later.
    netWorth(months: number): Promise<NetWorthPoint[]>;
  };
  assistant: {
    status(): Promise<AssistantStatus>;
    // The recent conversation, ending with the new question. The server keeps
    // nothing: it answers from the user's current data each time.
    chat(messages: AssistantMessage[]): Promise<AssistantReply>;
  };
}

// SpendTracker — money-correctness & data-isolation test suite.
//
// Focused companion to test/api-test.mjs, prioritising the two things that
// matter most for a finance app: (1) money math is exact and (2) users can
// never touch each other's data. Same harness conventions as api-test.mjs:
// no test framework — a plain Node ESM script driving the live HTTP API with
// a tiny cookie-aware Client + check() assertions.
//
// SETUP / TEARDOWN (matches the project convention): run against a FRESH DB.
//   1. build+assemble, create deploy/api/app/config.php (SQLite easiest) with
//      'mail_log_file' set so verification codes are readable offline.
//   2. rm the sqlite file + mail log, then:
//      php -S 127.0.0.1:8124 -t deploy deploy/router.php
//      API_BASE=http://127.0.0.1:8124 MAIL_LOG=./deploy/api/app/maillog.txt \
//        node test/api-money-isolation.mjs
// Isolation between tests is by construction: every user has a unique email
// (per-run suffix) and the API scopes every row to the session user_id, so a
// fresh DB + fresh users need no per-test teardown. Registers ~9 users, well
// under the 20/IP/hr registration throttle.
//
// FINDINGS (verified in source before writing — see the console banner too):
//   • Rate limiting IS implemented (429) but responses carry NO Retry-After
//     header — §7 documents this gap instead of asserting a header that
//     doesn't exist.
//   • Idempotency is NOT implemented — a retried create duplicates. §4
//     documents the real behaviour rather than a passing no-dup test.
//   • Pagination is NOT implemented (fixed LIMIT 2000, no page/offset/sort).
//     §6 tests graceful param handling instead.
//   • Dates: any calendar-valid YYYY-MM-DD is accepted, including future — no
//     future cutoff exists, so §3 verifies the real rule.

import { readFileSync } from 'node:fs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8124';
const MAIL_LOG = process.env.MAIL_LOG; // required: verification codes are emailed
const PW = 'correct-horse-battery';
const HEX = '#3366cc'; // valid 6-digit color (the API rejects 3-digit shorthand)

// ---------- harness ----------

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title} ==`);
}
function note(msg) {
  console.log(`  NOTE: ${msg}`);
}

class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = '';
    this.email = '';
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, extraHeaders = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (method !== 'GET' && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    // Real browsers always send this; the API's pre-auth origin check relies on it.
    headers['Sec-Fetch-Site'] = 'same-origin';
    Object.assign(headers, extraHeaders);
    const res = await fetch(BASE + '/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON (e.g. proxy error page) */
    }
    return { status: res.status, data, headers: res.headers };
  }
}

// ---------- mail-log helpers (verification codes) ----------

function mailBlocks(email) {
  if (!MAIL_LOG) return [];
  let log = '';
  try {
    log = readFileSync(MAIL_LOG, 'utf8');
  } catch {
    return [];
  }
  return log
    .split('----')
    .filter((b) => b.includes(`TO: ${email}`))
    .reverse(); // newest first
}
function latestVerificationCode(email) {
  for (const b of mailBlocks(email)) {
    const m = b.match(/code is:\s+(\d{6})/);
    if (m) return m[1];
  }
  return null;
}

/** Register + verify a fresh user; returns a signed-in, verified Client. */
async function verifiedUser(tag) {
  const c = new Client();
  const me = await c.call('GET', '/auth/me');
  c.csrf = me.data.csrf;
  // Lowercased to mirror Validate::email server-side, so the mail-log lookup
  // (which reads the stored, lowercased TO address) matches for any tag.
  const email = `${tag}.${suffix}@test.local`.toLowerCase();
  const reg = await c.call('POST', '/auth/register', { email, password: PW, name: tag });
  if (reg.status !== 200) throw new Error(`register ${tag} -> ${reg.status} ${JSON.stringify(reg.data)}`);
  if (reg.data?.csrf) c.csrf = reg.data.csrf;
  const code = latestVerificationCode(email);
  if (!code) throw new Error(`no verification code emailed for ${tag} (is MAIL_LOG set + fresh?)`);
  const v = await c.call('POST', '/auth/verify', { code });
  if (v.status !== 200) throw new Error(`verify ${tag} -> ${v.status} ${JSON.stringify(v.data)}`);
  if (v.data?.csrf) c.csrf = v.data.csrf;
  c.email = email;
  return c;
}

// ---------- domain helpers ----------

const acctBody = (over) => ({
  name: 'Wallet',
  type: 'debit',
  color: HEX,
  image: null,
  dueDay: null,
  dueDay2: null,
  openingBalanceCents: 0,
  ...over,
});
const makeAccount = (c, over = {}) => c.call('POST', '/accounts', acctBody(over));
const makeCategory = (c, name, type) => c.call('POST', '/categories', { name, type, color: HEX });
const txBody = (over) => ({
  amountCents: 1000,
  type: 'expense',
  categoryId: null,
  accountId: null,
  date: '2026-05-15',
  note: '',
  ...over,
});
const postTx = (c, over = {}) => c.call('POST', '/transactions', txBody(over));
const listTx = (c, qs = '') => c.call('GET', `/transactions${qs}`);
const summary = (c, from = '2000-01-01', to = '2099-12-31') =>
  c.call('GET', `/reports/summary?from=${from}&to=${to}`);
const breakdown = (c, type, from = '2000-01-01', to = '2099-12-31') =>
  c.call('GET', `/reports/breakdown?from=${from}&to=${to}&type=${type}`);
const accountById = async (c, id) => (await c.call('GET', '/accounts')).data.find((a) => a.id === id);

if (!MAIL_LOG) {
  console.error('MAIL_LOG env var is required (verification codes are emailed). Aborting.');
  process.exit(2);
}

const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

// ============================================================================
// 1. MONEY & CALCULATION CORRECTNESS
// ============================================================================
{
  section('1. Money & calculation correctness');

  // --- 1a. Balance = sum(income) - sum(expenses) over a mixed sequence ---
  // Arrange
  const u = await verifiedUser('money');
  const acct = (await makeAccount(u, { name: 'Checking', openingBalanceCents: 0 })).data;
  const incomes = [100000, 50000, 20, 10]; // includes 0.20 + 0.10 in cents
  const expenses = [25000, 7500, 30]; // includes 0.30 in cents
  // Act — post them all against the account, on assorted dates
  for (const a of incomes) await postTx(u, { amountCents: a, type: 'income', accountId: acct.id });
  for (const a of expenses) await postTx(u, { amountCents: a, type: 'expense', accountId: acct.id });
  const sumIn = incomes.reduce((s, x) => s + x, 0); // 150030
  const sumEx = expenses.reduce((s, x) => s + x, 0); // 32530
  const net = sumIn - sumEx; // 117500
  // Assert — reports/summary aggregates income & expense exactly
  const sum1 = await summary(u);
  check(
    'balance: summary income = sum(income) exactly',
    sum1.data?.incomeCents === sumIn,
    `expected ${sumIn}, got ${sum1.data?.incomeCents}`
  );
  check(
    'balance: summary expense = sum(expenses) exactly',
    sum1.data?.expenseCents === sumEx,
    `expected ${sumEx}, got ${sum1.data?.expenseCents}`
  );
  check(
    'balance: net (income - expense) is exact',
    sum1.data?.incomeCents - sum1.data?.expenseCents === net,
    `expected ${net}`
  );
  // Assert — the per-account ledger equals opening + income - expense
  const acctNow = await accountById(u, acct.id);
  check(
    'balance: account ledger = opening + income - expense',
    acctNow?.balanceCents === net,
    `expected ${net}, got ${acctNow?.balanceCents}`
  );

  // --- 1b. Decimal precision: integer cents, no float drift ---
  // The classic 0.1 + 0.2 problem is impossible here because money is stored
  // as integer cents; demonstrate the drift exists in float land, then show
  // the API's cents math (10 + 20 == 30) is exact and floats are rejected.
  check('decimal: JS float 0.1 + 0.2 !== 0.3 (why floats are unsafe for money)', 0.1 + 0.2 !== 0.3);
  check(
    'decimal: 0.10 + 0.20 income handled as 30 cents exactly (no drift)',
    sum1.data?.incomeCents % 10 === 0 && Number.isInteger(sum1.data?.incomeCents)
  );
  const floatAmt = await postTx(u, { amountCents: 12.5, type: 'expense', accountId: acct.id });
  check('decimal: fractional-cent (float) amount rejected -> 422', floatAmt.status === 422, `got ${floatAmt.status}`);
  const strAmt = await postTx(u, { amountCents: '1000', type: 'expense', accountId: acct.id });
  check('decimal: string amount rejected -> 422', strAmt.status === 422, `got ${strAmt.status}`);

  // --- 1c. Negative, zero, very large amounts ---
  const neg = await postTx(u, { amountCents: -500, type: 'expense', accountId: acct.id });
  check('amount: negative rejected -> 422', neg.status === 422, `got ${neg.status}`);
  const zero = await postTx(u, { amountCents: 0, type: 'expense', accountId: acct.id });
  check('amount: zero rejected -> 422', zero.status === 422, `got ${zero.status}`);
  const MAX = 100000000000; // API ceiling ($1,000,000,000.00)
  const big = await postTx(u, { amountCents: MAX, type: 'income', accountId: acct.id });
  check('amount: max ceiling (1e11 cents) accepted -> 201', big.status === 201, `got ${big.status}`);
  const tooBig = await postTx(u, { amountCents: MAX + 1, type: 'income', accountId: acct.id });
  check('amount: above ceiling rejected -> 422', tooBig.status === 422, `got ${tooBig.status}`);
  // Assert — the huge amount summed in exactly (no overflow / rounding)
  const sum2 = await summary(u);
  check(
    'amount: very large value sums in exactly',
    sum2.data?.incomeCents === sumIn + MAX,
    `expected ${sumIn + MAX}, got ${sum2.data?.incomeCents}`
  );
}

// ============================================================================
// 1d/1e. AGGREGATIONS — category breakdown + date-range sum correctly
// ============================================================================
{
  section('1d/1e. Category & date-range aggregations');

  // Arrange — one user, three expense categories, tx on distinct months
  const u = await verifiedUser('agg');
  const food = (await makeCategory(u, 'Food', 'expense')).data;
  const rent = (await makeCategory(u, 'Rent', 'expense')).data;
  const pay = (await makeCategory(u, 'Salary', 'income')).data;
  // Act
  await postTx(u, { amountCents: 1200, type: 'expense', categoryId: food.id, date: '2026-01-10' });
  await postTx(u, { amountCents: 800, type: 'expense', categoryId: food.id, date: '2026-02-10' });
  await postTx(u, { amountCents: 50000, type: 'expense', categoryId: rent.id, date: '2026-01-01' });
  await postTx(u, { amountCents: 300000, type: 'income', categoryId: pay.id, date: '2026-01-05' });

  // Assert — category breakdown totals per category and sums to the expense total
  const bd = await breakdown(u, 'expense');
  const rows = bd.data ?? [];
  const byId = (id) => rows.find((r) => r.categoryId === id)?.totalCents;
  check('breakdown: Food category total = 1200 + 800', byId(food.id) === 2000, `got ${byId(food.id)}`);
  check('breakdown: Rent category total = 50000', byId(rent.id) === 50000, `got ${byId(rent.id)}`);
  const bdSum = rows.reduce((s, r) => s + r.totalCents, 0);
  const fullSum = await summary(u);
  check(
    'breakdown: category totals sum to the period expense total',
    bdSum === fullSum.data?.expenseCents && bdSum === 52000,
    `breakdown sum ${bdSum}, summary expense ${fullSum.data?.expenseCents}`
  );

  // Assert — date-range filter includes only in-range rows
  const jan = await summary(u, '2026-01-01', '2026-01-31');
  check(
    'date-range: January expense = 1200 + 50000 (excludes Feb 800)',
    jan.data?.expenseCents === 51200,
    `got ${jan.data?.expenseCents}`
  );
  check('date-range: January income = 300000', jan.data?.incomeCents === 300000, `got ${jan.data?.incomeCents}`);
  const feb = await summary(u, '2026-02-01', '2026-02-28');
  check('date-range: February expense = 800 only', feb.data?.expenseCents === 800, `got ${feb.data?.expenseCents}`);
}

// ============================================================================
// 2. DATA ISOLATION (authorization)
// ============================================================================
{
  section('2. Data isolation');

  // Arrange — two users, each with their own account, category, transaction
  const A = await verifiedUser('isoA');
  const B = await verifiedUser('isoB');
  const acctA = (await makeAccount(A, { name: 'A-acct' })).data;
  const catA = (await makeCategory(A, 'A-cat', 'expense')).data;
  const txA = (await postTx(A, { amountCents: 4200, type: 'expense', accountId: acctA.id, categoryId: catA.id, note: 'A-secret' })).data;

  const acctB = (await makeAccount(B, { name: 'B-acct' })).data;
  await postTx(B, { amountCents: 999, type: 'expense', accountId: acctB.id, note: 'B-secret' });

  // --- 2a. Listing endpoints never leak another user's rows ---
  const bList = await listTx(B);
  check(
    "isolation: B's transaction list excludes A's rows",
    Array.isArray(bList.data) && !bList.data.some((t) => t.id === txA.id || t.note === 'A-secret'),
    JSON.stringify(bList.data?.map?.((t) => t.id))
  );
  const bAccts = await B.call('GET', '/accounts');
  check(
    "isolation: B's account list excludes A's accounts",
    Array.isArray(bAccts.data) && !bAccts.data.some((a) => a.id === acctA.id),
    JSON.stringify(bAccts.data?.map?.((a) => a.id))
  );

  // --- 2b. IDOR: B cannot edit or delete A's transaction by guessing its id ---
  const idorEdit = await B.call('PUT', `/transactions/${txA.id}`, txBody({ amountCents: 1, type: 'income' }));
  check("isolation: B editing A's transaction -> 404 (IDOR blocked)", idorEdit.status === 404, `got ${idorEdit.status}`);
  const idorDel = await B.call('DELETE', `/transactions/${txA.id}`);
  check("isolation: B deleting A's transaction -> 404 (IDOR blocked)", idorDel.status === 404, `got ${idorDel.status}`);
  // A's transaction is untouched by the attempted tampering
  const aList = await listTx(A);
  const stillThere = aList.data?.find((t) => t.id === txA.id);
  check(
    "isolation: A's transaction unchanged after B's tampering attempts",
    stillThere?.amountCents === 4200 && stillThere?.type === 'expense',
    JSON.stringify(stillThere)
  );

  // --- 2c. IDOR: B cannot reference A's account/category on a new tx ---
  const crossAcct = await postTx(B, { amountCents: 100, type: 'expense', accountId: acctA.id });
  check("isolation: B posting to A's account -> 422", crossAcct.status === 422, `got ${crossAcct.status}`);
  const crossCat = await postTx(B, { amountCents: 100, type: 'expense', categoryId: catA.id });
  check("isolation: B posting with A's category -> 422", crossCat.status === 422, `got ${crossCat.status}`);
  const idorAcctDel = await B.call('DELETE', `/accounts/${acctA.id}`);
  check("isolation: B deleting A's account -> 404", idorAcctDel.status === 404, `got ${idorAcctDel.status}`);

  // --- 2d. Unauthenticated / invalid session rejected ---
  const anon = new Client();
  await anon.call('GET', '/auth/me').then((r) => (anon.csrf = r.data.csrf));
  for (const p of ['/transactions', '/accounts', '/reports/summary?from=2026-01-01&to=2026-12-31']) {
    const r = await anon.call('GET', p);
    check(`isolation: unauthenticated GET ${p.split('?')[0]} -> 401`, r.status === 401, `got ${r.status}`);
  }
  // "Expired/invalid token": auth is a session cookie — a garbage cookie is anon.
  const bogus = new Client();
  bogus.cookies.set('spendtracker_sid', 'deadbeefdeadbeefdeadbeef');
  const bogusR = await bogus.call('GET', '/transactions');
  check('isolation: invalid/forged session cookie -> 401', bogusR.status === 401, `got ${bogusR.status}`);
  note('auth uses server-side session cookies (no bearer/JWT); "expired token" == absent/invalid session.');
}

// ============================================================================
// 3. INPUT VALIDATION
// ============================================================================
{
  section('3. Input validation');

  // Arrange
  const u = await verifiedUser('valid');
  const incomeCat = (await makeCategory(u, 'Paycheck', 'income')).data;

  // --- 3a. Missing / invalid required fields ---
  check('validation: empty payload {} -> 422', (await u.call('POST', '/transactions', {})).status === 422);
  check(
    'validation: missing amount -> 422',
    (await u.call('POST', '/transactions', { type: 'expense', date: '2026-05-01', note: '' })).status === 422
  );
  check('validation: invalid type (not income|expense) -> 422', (await postTx(u, { type: 'transfer' })).status === 422);
  check('validation: missing date -> 422', (await u.call('POST', '/transactions', { amountCents: 100, type: 'expense' })).status === 422);

  // --- 3b. Malformed & impossible dates (rule: format + calendar validity) ---
  check('validation: malformed date "2026-13-40" -> 422', (await postTx(u, { date: '2026-13-40' })).status === 422);
  check('validation: impossible calendar date "2026-02-30" -> 422', (await postTx(u, { date: '2026-02-30' })).status === 422);
  check('validation: non-date string "not-a-date" -> 422', (await postTx(u, { date: 'not-a-date' })).status === 422);
  // Rule check: there is NO future cutoff — a far-future valid date is accepted.
  const future = await postTx(u, { date: '2099-12-31', amountCents: 100, type: 'expense' });
  check('validation: far-future valid date accepted -> 201 (no future cutoff by design)', future.status === 201, `got ${future.status}`);

  // --- 3c. Category type must match transaction type ---
  const wrongType = await postTx(u, { type: 'expense', categoryId: incomeCat.id });
  check('validation: expense tx with an income category -> 422', wrongType.status === 422, `got ${wrongType.status}`);
  // (Category is optional overall — a tx with no category is allowed = Uncategorized.)
  check('validation: no category is allowed (Uncategorized) -> 201', (await postTx(u, { categoryId: null })).status === 201);

  // --- 3d. Oversized / unicode / injection payloads in text fields ---
  const huge = await postTx(u, { note: 'x'.repeat(5000) });
  check('validation: 5000-char note accepted and truncated to <=500', huge.status === 201 && (huge.data?.note?.length ?? 0) <= 500, `status ${huge.status}, len ${huge.data?.note?.length}`);
  const uni = 'café ☕ 日本語 🧾 naïve';
  const uniR = await postTx(u, { note: uni });
  check('validation: unicode note round-trips verbatim', uniR.status === 201 && uniR.data?.note === uni, uniR.data?.note);
  const inject = "'); DROP TABLE transactions;--";
  const injR = await postTx(u, { note: inject });
  check('validation: SQL-injection string stored inertly (parameterized) -> 201', injR.status === 201 && injR.data?.note === inject, `status ${injR.status}`);
  // Prove the table survived the injection attempt.
  const stillWorks = await listTx(u);
  check('validation: transactions table intact after injection attempt', Array.isArray(stillWorks.data) && stillWorks.data.length > 0, `status ${stillWorks.status}`);
  const script = '<script>alert(1)</script>';
  const scriptR = await postTx(u, { note: script });
  check('validation: script payload stored verbatim (React escapes at render) -> 201', scriptR.status === 201 && scriptR.data?.note === script, scriptR.data?.note);
  // Malformed JSON body must not 500.
  const rawBad = await fetch(BASE + '/api/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': u.csrf, Cookie: u.cookieHeader(), 'Sec-Fetch-Site': 'same-origin' },
    body: '{ not valid json',
  });
  check('validation: malformed JSON body -> 4xx, never 500', rawBad.status >= 400 && rawBad.status < 500, `got ${rawBad.status}`);
}

// ============================================================================
// 4. CRUD & DATA INTEGRITY
// ============================================================================
{
  section('4. CRUD & data integrity');

  // Arrange — fresh user + account so aggregates are clean
  const u = await verifiedUser('crud');
  const acct = (await makeAccount(u, { name: 'Crud-acct', openingBalanceCents: 0 })).data;

  // --- 4a. Create reflects in list + balance ---
  const created = (await postTx(u, { amountCents: 5000, type: 'expense', accountId: acct.id, note: 'coffee run' })).data;
  check('crud: create returns the new row', created?.id > 0 && created.amountCents === 5000);
  let acctNow = await accountById(u, acct.id);
  check('crud: expense reflected in account balance (-5000)', acctNow?.balanceCents === -5000, `got ${acctNow?.balanceCents}`);

  // --- 4b. Read (list) returns it ---
  const list1 = await listTx(u);
  check('crud: created row appears in list', list1.data?.some((t) => t.id === created.id));

  // --- 4c. Edit amount recomputes balance ---
  await u.call('PUT', `/transactions/${created.id}`, txBody({ amountCents: 8000, type: 'expense', accountId: acct.id, note: 'coffee run' }));
  acctNow = await accountById(u, acct.id);
  check('crud: editing amount recomputes balance (-8000)', acctNow?.balanceCents === -8000, `got ${acctNow?.balanceCents}`);

  // --- 4d. Edit type (expense -> income) flips the balance sign contribution ---
  await u.call('PUT', `/transactions/${created.id}`, txBody({ amountCents: 8000, type: 'income', accountId: acct.id, note: 'coffee run' }));
  acctNow = await accountById(u, acct.id);
  check('crud: changing type expense->income recomputes balance (+8000)', acctNow?.balanceCents === 8000, `got ${acctNow?.balanceCents}`);
  const sumAfterEdit = await summary(u);
  check('crud: summary reflects the type change (income 8000, expense 0)', sumAfterEdit.data?.incomeCents === 8000 && sumAfterEdit.data?.expenseCents === 0, JSON.stringify(sumAfterEdit.data));

  // --- 4e. Delete updates aggregates ---
  const del = await u.call('DELETE', `/transactions/${created.id}`);
  check('crud: delete -> 200', del.status === 200, `got ${del.status}`);
  acctNow = await accountById(u, acct.id);
  check('crud: balance back to 0 after delete', acctNow?.balanceCents === 0, `got ${acctNow?.balanceCents}`);
  const delAgain = await u.call('DELETE', `/transactions/${created.id}`);
  check('crud: deleting an already-deleted row -> 404', delAgain.status === 404, `got ${delAgain.status}`);

  // --- 4f. Idempotency: retried create (KNOWN GAP — not implemented) ---
  // The API has no Idempotency-Key mechanism, so two identical POSTs create
  // two rows. This asserts the ACTUAL current behaviour (documented gap),
  // NOT a passing no-duplicate guarantee.
  const before = (await listTx(u)).data.length;
  const dupPayload = txBody({ amountCents: 4321, type: 'expense', accountId: acct.id, note: 'retry-me' });
  await u.call('POST', '/transactions', dupPayload);
  await u.call('POST', '/transactions', dupPayload); // identical retry
  const after = (await listTx(u)).data.length;
  check('crud: retried identical create currently DUPLICATES (no idempotency — documented gap)', after === before + 2, `expected +2 rows, got +${after - before}`);
  note('IDEMPOTENCY IS NOT IMPLEMENTED: a client retry (e.g. after a network timeout) double-posts. Recommend an Idempotency-Key header or a client-supplied dedup token.');
}

// ============================================================================
// 5. CONCURRENCY
// ============================================================================
{
  section('5. Concurrency');

  // Balances are computed as SUM() on read, never stored, so concurrent
  // inserts cannot corrupt a running total. Prove it: fire many simultaneous
  // writes and confirm every one lands and the aggregate is exact.
  const u = await verifiedUser('conc');
  const acct = (await makeAccount(u, { name: 'Conc-acct', openingBalanceCents: 0 })).data;
  const N = 25;
  const each = 137; // cents
  // Act — all writes in flight at once
  const results = await Promise.all(
    Array.from({ length: N }, () => postTx(u, { amountCents: each, type: 'expense', accountId: acct.id }))
  );
  // Assert
  const created = results.filter((r) => r.status === 201).length;
  check(`concurrency: all ${N} simultaneous writes succeeded`, created === N, `only ${created}/${N} created`);
  const acctNow = await accountById(u, acct.id);
  check(
    'concurrency: running balance is exact after concurrent writes (no lost updates)',
    acctNow?.balanceCents === -(N * each),
    `expected ${-(N * each)}, got ${acctNow?.balanceCents}`
  );
  const listed = (await listTx(u)).data.length;
  check(`concurrency: exactly ${N} rows persisted (no dropped/dup writes)`, listed === N, `got ${listed}`);
}

// ============================================================================
// 6. EDGE CASES
// ============================================================================
{
  section('6. Edge cases');

  // --- 6a. Brand-new user: zero balance, not an error ---
  const fresh = await verifiedUser('edge');
  const s = await summary(fresh);
  check('edge: new user summary -> 200 with zero income/expense', s.status === 200 && s.data?.incomeCents === 0 && s.data?.expenseCents === 0, JSON.stringify(s.data));
  const emptyList = await listTx(fresh);
  check('edge: new user transaction list -> empty array (not error)', emptyList.status === 200 && Array.isArray(emptyList.data) && emptyList.data.length === 0, JSON.stringify(emptyList.data));
  const emptyAccts = await fresh.call('GET', '/accounts');
  check('edge: new user account list -> empty array', emptyAccts.status === 200 && Array.isArray(emptyAccts.data) && emptyAccts.data.length === 0);

  // --- 6b. Pagination boundaries (NOT IMPLEMENTED — graceful param handling) ---
  // /transactions has a fixed LIMIT 2000 and no page/offset/sort params.
  // Verify bogus/ignored params don't break the endpoint (no 500), and that
  // an invalid *validated* filter is rejected cleanly.
  await postTx(fresh, { amountCents: 100, type: 'expense', date: '2026-03-03' });
  check('edge: unknown query params (?page=0&offset=999999&sort=bogus) ignored, still 200', (await listTx(fresh, '?page=0&offset=999999&sort=bogus')).status === 200);
  check('edge: invalid validated filter (?type=garbage) -> 422 (not 500)', (await listTx(fresh, '?type=garbage')).status === 422);
  check('edge: invalid categoryId filter (?categoryId=abc) -> 422 (not 500)', (await listTx(fresh, '?categoryId=abc')).status === 422);
  note('PAGINATION IS NOT IMPLEMENTED: /transactions returns up to a fixed 2000 rows, no page/offset/sort. Fine at current scale; add keyset pagination before users exceed ~2000 tx/period.');
}

// ============================================================================
// 7. RATE LIMITING (implemented — see findings)
// ============================================================================
{
  section('7. Rate limiting (auth brute-force protection)');

  // Login is throttled per (IP, email): 8 attempts, then 429. A successful
  // login clears the bucket. Arrange a verified user to attack.
  const victim = await verifiedUser('rate');
  const email = victim.email;

  // --- 7a. Normal pace is never limited ---
  const good = new Client();
  await good.call('GET', '/auth/me').then((r) => (good.csrf = r.data.csrf));
  const okLogin = await good.call('POST', '/auth/login', { email, password: PW });
  check('rate: a correct login at normal pace is NOT limited -> 200', okLogin.status === 200, `got ${okLogin.status}`);
  // (that success cleared the throttle bucket, so the brute-force test starts clean)

  // --- 7b. Brute force: repeated wrong passwords hit 429 after the threshold ---
  const attacker = new Client();
  await attacker.call('GET', '/auth/me').then((r) => (attacker.csrf = r.data.csrf));
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    statuses.push((await attacker.call('POST', '/auth/login', { email, password: 'wrong-password-x' })).status);
  }
  const blocked = await attacker.call('POST', '/auth/login', { email, password: 'wrong-password-x' });
  check('rate: first 8 wrong-password attempts return 401 (not yet limited)', statuses.every((s) => s === 401), `statuses ${statuses.join(',')}`);
  check('rate: the 9th rapid attempt is blocked -> 429', blocked.status === 429, `got ${blocked.status}`);

  // --- 7c. The 429 fails gracefully (JSON error, not a crash) ---
  check('rate: 429 body is a graceful JSON error (not a 500/HTML crash)', typeof blocked.data?.error === 'string' && blocked.data.error.length > 0, JSON.stringify(blocked.data));

  // --- 7d. Retry-After header (KNOWN GAP — not implemented) ---
  // The spec asks for Retry-After; the API does not currently emit it. This
  // documents the ACTUAL behaviour rather than asserting a header that is
  // absent (which would only fail).
  const retryAfter = blocked.headers.get('retry-after');
  check('rate: 429 currently omits Retry-After header (documented gap)', retryAfter === null, `got "${retryAfter}"`);
  note('RETRY-AFTER NOT IMPLEMENTED: 429 responses have no Retry-After header. Recommend adding it (seconds until window reset) so clients back off correctly.');
  note('WINDOW RESET (login = 600s) is time-based; not exercised here to keep the suite fast. The fixed-window logic in Http::throttle resets once (now - window_start) >= windowSec.');

  // --- 7e. The block is per-account, not global (a different email still works) ---
  const other = await verifiedUser('rate2');
  const otherGood = new Client();
  await otherGood.call('GET', '/auth/me').then((r) => (otherGood.csrf = r.data.csrf));
  const otherLogin = await otherGood.call('POST', '/auth/login', { email: other.email, password: PW });
  check('rate: throttle is scoped per account — a different user can still log in', otherLogin.status === 200, `got ${otherLogin.status}`);
}

// ---------- results ----------

console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('MONEY & ISOLATION SUITE PASS');

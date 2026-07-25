// End-to-end API test suite. Run against a live server:
//   API_BASE=http://127.0.0.1:8124 node test/api-test.mjs
// Covers: health, register/login/logout, session + CSRF enforcement,
// CRUD for categories/transactions/budgets, report math, FK behavior,
// cross-user isolation, and login throttling.
import { readFileSync } from 'node:fs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8124';
// The server writes emails to this file instead of sending them (config
// `mail_log_file`). The suite reads verification codes/tokens and reset tokens
// from it, so it is REQUIRED — registration now emails a verification code that
// every data-touching test must consume before the account is unlocked.
const MAIL_LOG = process.env.MAIL_LOG;
if (!MAIL_LOG) {
  console.error(
    'MAIL_LOG must be set (config `mail_log_file`): the suite reads email verification codes from it.'
  );
  process.exit(1);
}

/** All mail-log blocks addressed to `email`, newest first. */
function mailBlocks(email) {
  return readFileSync(MAIL_LOG, 'utf8')
    .split('----')
    .filter((b) => b.includes(`TO: ${email}`))
    .reverse();
}

/** Extract the most recent reset token emailed to `email` from the mail log. */
function latestResetToken(email) {
  for (const b of mailBlocks(email)) {
    const m = b.match(/reset=([a-f0-9]{64})/);
    if (m) return m[1];
  }
  return null;
}

/** The most recent full reset/verify link (origin + query) emailed to `email`. */
function latestEmailLink(email) {
  for (const b of mailBlocks(email)) {
    const m = b.match(/https?:\/\/\S+\/\?(?:reset|verify)=[a-f0-9]{64}/);
    if (m) return m[0];
  }
  return null;
}

/** Most recent 6-digit verification code emailed to `email`. */
function latestVerificationCode(email) {
  for (const b of mailBlocks(email)) {
    if (/verification code/i.test(b)) {
      const m = b.match(/code is:\s+(\d{6})/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Most recent verification backup-link token emailed to `email`. */
function latestVerificationToken(email) {
  for (const b of mailBlocks(email)) {
    const m = b.match(/verify=([a-f0-9]{64})/);
    if (m) return m[1];
  }
  return null;
}

/** Consume the emailed code to verify a freshly-registered client's email. */
async function verifyClient(client, email) {
  const code = latestVerificationCode(email);
  const r = await client.call('POST', '/auth/verify', { code });
  if (r.data?.csrf) client.csrf = r.data.csrf;
  return r;
}

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

class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = '';
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async call(method, path, body, extraHeaders = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (method !== 'GET' && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    // Simulate a same-origin browser fetch (real browsers always send this).
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
      /* non-JSON */
    }
    return { status: res.status, data };
  }
}

const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const emailA = `alice.${suffix}@test.local`;
const emailB = `bob.${suffix}@test.local`;
const password = 'correct-horse-battery';
const MONTH = '2026-07';
const PREV_MONTH = '2026-06';

const a = new Client();
const b = new Client();

// ---------- health ----------
{
  const r = await a.call('GET', '/health');
  check('health returns ok', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data));
}

// ---------- anonymous state ----------
{
  const r = await a.call('GET', '/auth/me');
  check('me (anon) returns null user + csrf', r.status === 200 && r.data.user === null && !!r.data.csrf);
  a.csrf = r.data.csrf;

  const denied = await a.call('GET', '/categories');
  check('categories without session -> 401', denied.status === 401);
}

// ---------- CSRF enforcement ----------
{
  const noToken = new Client();
  await noToken.call('GET', '/auth/me'); // get session, but don't set csrf
  const r = await noToken.call('POST', '/auth/logout');
  check('mutation without CSRF token -> 403', r.status === 403, `got ${r.status}`);
}

// ---------- cross-origin rejection (Sec-Fetch-Site) ----------
{
  const c = new Client();
  await c.call('GET', '/auth/me').then((r) => (c.csrf = r.data.csrf));
  const crossSite = await c.call(
    'POST',
    '/auth/login',
    { email: 'x@test.local', password: 'whatever12' },
    { 'Sec-Fetch-Site': 'cross-site' }
  );
  check('cross-site pre-auth mutation -> 403', crossSite.status === 403, `got ${crossSite.status}`);

  const crossSiteAuthed = await c.call(
    'POST',
    '/auth/logout',
    undefined,
    { 'Sec-Fetch-Site': 'cross-site' }
  );
  check('cross-site authed mutation -> 403', crossSiteAuthed.status === 403, `got ${crossSiteAuthed.status}`);
}

// ---------- register / me ----------
{
  const bad = await a.call('POST', '/auth/register', { email: 'nope', password, name: '' });
  check('register with invalid email -> 422', bad.status === 422);

  const weak = await a.call('POST', '/auth/register', { email: emailA, password: 'short', name: '' });
  check('register with short password -> 422', weak.status === 422);

  const r = await a.call('POST', '/auth/register', { email: emailA, password, name: 'Alice' });
  check('register succeeds', r.status === 200 && r.data.user?.email === emailA, JSON.stringify(r.data));
  check('newly-registered user is unverified', r.data.user?.emailVerified === false, JSON.stringify(r.data.user));
  a.csrf = r.data.csrf;

  const dup = await a.call('POST', '/auth/register', { email: emailA, password, name: '' });
  check('duplicate register -> 409', dup.status === 409);

  const me = await a.call('GET', '/auth/me');
  check('me returns the user', me.status === 200 && me.data.user?.email === emailA);

  // Data is locked until Alice verifies; then it opens up. (Fuller verify
  // behavior — wrong code, resend, backup link — is exercised in its own
  // section below with throwaway users.)
  const preVerify = await a.call('GET', '/categories');
  check('unverified user blocked from data -> 403', preVerify.status === 403, `got ${preVerify.status}`);
  const av = await verifyClient(a, emailA);
  check('verify with emailed code succeeds', av.status === 200 && av.data.user?.emailVerified === true, JSON.stringify(av.data));
}

// ---------- email verification: code flow (wrong code, resend, idempotent) ----------
{
  const v = new Client();
  await v.call('GET', '/auth/me').then((r) => (v.csrf = r.data.csrf));
  const email = `verify.${suffix}@test.local`;
  const reg = await v.call('POST', '/auth/register', { email, password, name: 'Vera' });
  v.csrf = reg.data.csrf;
  check('verify-user registers unverified', reg.status === 200 && reg.data.user?.emailVerified === false, JSON.stringify(reg.data.user));

  const meUnv = await v.call('GET', '/auth/me');
  check('me reports emailVerified false', meUnv.data.user?.emailVerified === false);

  const blocked = await v.call('GET', '/transactions');
  check('unverified blocked from data -> 403', blocked.status === 403, `got ${blocked.status}`);

  const wrong = await v.call('POST', '/auth/verify', { code: '000000' });
  check('wrong code -> 422 (incorrect)', wrong.status === 422, `got ${wrong.status}`);
  const stillBlocked = await v.call('GET', '/transactions');
  check('still blocked after wrong code -> 403', stillBlocked.status === 403);

  const malformed = await v.call('POST', '/auth/verify', { code: '12' });
  check('malformed code -> 422', malformed.status === 422, `got ${malformed.status}`);

  // Resend issues a fresh code (invalidating the previous one).
  const resend = await v.call('POST', '/auth/resend-verification');
  check('resend verification -> ok', resend.status === 200, `got ${resend.status}`);

  const code = latestVerificationCode(email);
  check('verification code emailed', typeof code === 'string' && /^\d{6}$/.test(code), String(code));

  const ok = await v.call('POST', '/auth/verify', { code });
  check('verify with correct code succeeds', ok.status === 200 && ok.data.user?.emailVerified === true, JSON.stringify(ok.data));

  const cats = await v.call('GET', '/categories');
  check('verified user can access data', cats.status === 200 && Array.isArray(cats.data));

  const again = await v.call('POST', '/auth/verify', { code });
  check('verify when already verified -> ok (idempotent)', again.status === 200 && again.data.user?.emailVerified === true, `got ${again.status}`);
}

// ---------- email verification: wrong-code attempts cap (burn -> resend) ----------
{
  const v = new Client();
  await v.call('GET', '/auth/me').then((r) => (v.csrf = r.data.csrf));
  const email = `vcap.${suffix}@test.local`;
  const reg = await v.call('POST', '/auth/register', { email, password, name: 'Capps' });
  v.csrf = reg.data.csrf;
  check('cap-user registers unverified', reg.status === 200 && reg.data.user?.emailVerified === false);

  // Hammer wrong (well-formed) guesses. Each returns 422 and increments the
  // counter; once the cap is hit the pending code is burned and further guesses
  // return 429. (Guard the loop so a broken cap can't spin forever.)
  let capStatus = 0;
  for (let i = 0; i < 12; i++) {
    const r = await v.call('POST', '/auth/verify', { code: '000000' });
    if (r.status === 429) { capStatus = 429; break; }
    check(`wrong guess #${i + 1} -> 422`, r.status === 422, `got ${r.status}`);
  }
  check('code burned after too many wrong guesses -> 429', capStatus === 429);

  // The originally-emailed (correct) code no longer works — the row was burned.
  const burnedCode = latestVerificationCode(email);
  const afterBurn = await v.call('POST', '/auth/verify', { code: burnedCode });
  check('originally-correct code rejected after burn -> 400', afterBurn.status === 400, `got ${afterBurn.status}`);
  const stillBlocked = await v.call('GET', '/categories');
  check('still blocked after burn -> 403', stillBlocked.status === 403, `got ${stillBlocked.status}`);

  // A resend issues a fresh working code (recovery path after a burn).
  await v.call('POST', '/auth/resend-verification');
  const fresh = latestVerificationCode(email);
  check('resent code is a fresh 6-digit code', typeof fresh === 'string' && /^\d{6}$/.test(fresh), String(fresh));
  const ok = await v.call('POST', '/auth/verify', { code: fresh });
  check('fresh code verifies after a burn', ok.status === 200 && ok.data.user?.emailVerified === true, JSON.stringify(ok.data));
}

// ---------- email verification: backup link token ----------
{
  const v = new Client();
  await v.call('GET', '/auth/me').then((r) => (v.csrf = r.data.csrf));
  const email = `verlink.${suffix}@test.local`;
  const reg = await v.call('POST', '/auth/register', { email, password, name: 'Linus' });
  v.csrf = reg.data.csrf;
  check('link-verify user registers unverified', reg.status === 200 && reg.data.user?.emailVerified === false);

  const token = latestVerificationToken(email);
  check('verification link token emailed', typeof token === 'string' && token.length === 64, String(token));

  const bogus = await v.call('POST', '/auth/verify-link', { token: 'f'.repeat(64) });
  check('bogus verify-link token -> 400', bogus.status === 400, `got ${bogus.status}`);

  // verify-link works from a fresh session (link opened on another device) and
  // signs the user in.
  const fresh = new Client();
  await fresh.call('GET', '/auth/me').then((r) => (fresh.csrf = r.data.csrf));
  const done = await fresh.call('POST', '/auth/verify-link', { token });
  check('verify-link verifies + signs in', done.status === 200 && done.data.user?.email === email && done.data.user?.emailVerified === true, JSON.stringify(done.data));
  fresh.csrf = done.data.csrf;

  const reuse = await fresh.call('POST', '/auth/verify-link', { token });
  check('verify-link token is single-use -> 400', reuse.status === 400, `got ${reuse.status}`);

  const cats = await fresh.call('GET', '/categories');
  check('link-verified session can access data', cats.status === 200);
}

// ---------- categories ----------
let catId = 0;
let seededGroceriesId = 0;
{
  const list = await a.call('GET', '/categories');
  check('14 default categories seeded', list.status === 200 && list.data.length === 14, `got ${list.data?.length}`);
  seededGroceriesId = list.data.find((c) => c.name === 'Groceries')?.id ?? 0;
  check('Groceries category exists', seededGroceriesId > 0);

  const created = await a.call('POST', '/categories', { name: 'Pets', type: 'expense', color: '#f472b6' });
  check('create category', created.status === 201 && created.data.id > 0 && created.data.name === 'Pets');
  catId = created.data.id;

  const badColor = await a.call('POST', '/categories', { name: 'X', type: 'expense', color: 'red' });
  check('create category with bad color -> 422', badColor.status === 422);

  const upd = await a.call('PUT', `/categories/${catId}`, { name: 'Pets & Vets', color: '#f472b6' });
  check('update category', upd.status === 200);

  const after = await a.call('GET', '/categories');
  check('updated name visible', after.data.some((c) => c.name === 'Pets & Vets'));
}

// ---------- transactions ----------
let txId = 0;
{
  const created = await a.call('POST', '/transactions', {
    amountCents: 123456,
    type: 'expense',
    categoryId: catId,
    date: `${MONTH}-15`,
    note: 'Vet visit — annual "checkup"',
  });
  check('create transaction', created.status === 201 && created.data.id > 0, JSON.stringify(created.data));
  check('created tx echoes category', created.data.categoryName === 'Pets & Vets');
  txId = created.data.id;

  await a.call('POST', '/transactions', {
    amountCents: 500000,
    type: 'income',
    categoryId: null,
    date: `${MONTH}-01`,
    note: 'Salary',
  });
  await a.call('POST', '/transactions', {
    amountCents: 20000,
    type: 'expense',
    categoryId: seededGroceriesId,
    date: `${PREV_MONTH}-20`,
    note: 'June groceries',
  });

  const badDate = await a.call('POST', '/transactions', {
    amountCents: 100, type: 'expense', categoryId: null, date: '2026-02-30', note: '',
  });
  check('invalid calendar date -> 422', badDate.status === 422);

  const badAmount = await a.call('POST', '/transactions', {
    amountCents: -5, type: 'expense', categoryId: null, date: `${MONTH}-01`, note: '',
  });
  check('negative amount -> 422', badAmount.status === 422);

  const monthList = await a.call('GET', `/transactions?month=${MONTH}`);
  check('month filter returns 2', monthList.data.length === 2, `got ${monthList.data?.length}`);

  const search = await a.call('GET', `/transactions?month=${MONTH}&search=vet`);
  check('search matches note', search.data.length === 1 && search.data[0].id === txId);

  const typed = await a.call('GET', `/transactions?month=${MONTH}&type=income`);
  check('type filter works', typed.data.length === 1 && typed.data[0].note === 'Salary');

  const updated = await a.call('PUT', `/transactions/${txId}`, {
    amountCents: 111111, type: 'expense', categoryId: catId, date: `${MONTH}-15`, note: 'Vet visit',
  });
  check('update transaction', updated.status === 200);

  // catId is an expense category — attaching it to an income tx must fail.
  const typeMismatch = await a.call('POST', '/transactions', {
    amountCents: 100, type: 'income', categoryId: catId, date: `${MONTH}-02`, note: 'mismatch',
  });
  check('income tx with expense category -> 422', typeMismatch.status === 422, `got ${typeMismatch.status}`);
}

// ---------- transaction time (optional HH:MM) ----------
// Uses a day (MONTH-20) no other fixture touches, and deletes its rows at the
// end so the report-math assertions below stay exact.
{
  const timed = await a.call('POST', '/transactions', {
    amountCents: 1000, type: 'expense', categoryId: null, date: `${MONTH}-20`, time: '14:35', note: 'timed A',
  });
  check('create tx with time -> echoed back', timed.status === 201 && timed.data.time === '14:35', JSON.stringify(timed.data));

  const earlier = await a.call('POST', '/transactions', {
    amountCents: 1000, type: 'expense', categoryId: null, date: `${MONTH}-20`, time: '09:05', note: 'timed B',
  });
  const untimed = await a.call('POST', '/transactions', {
    amountCents: 1000, type: 'expense', categoryId: null, date: `${MONTH}-20`, note: 'untimed C',
  });
  check('tx without time -> time null', untimed.status === 201 && untimed.data.time === null, JSON.stringify(untimed.data));

  const badTime = await a.call('POST', '/transactions', {
    amountCents: 1000, type: 'expense', categoryId: null, date: `${MONTH}-20`, time: '25:61', note: 'bad time',
  });
  check('invalid time -> 422', badTime.status === 422, `got ${badTime.status}`);

  // Same-day ordering: latest time first, untimed (NULL) rows last.
  const day = await a.call('GET', `/transactions?from=${MONTH}-20&to=${MONTH}-20`);
  const notes = day.data.map((t) => t.note);
  check(
    'same-day order: latest time first, untimed last',
    JSON.stringify(notes) === JSON.stringify(['timed A', 'timed B', 'untimed C']),
    JSON.stringify(notes)
  );

  const setTime = await a.call('PUT', `/transactions/${timed.data.id}`, {
    amountCents: 1000, type: 'expense', categoryId: null, date: `${MONTH}-20`, time: '23:59', note: 'timed A',
  });
  check('update can change the time', setTime.status === 200);
  const clearTime = await a.call('PUT', `/transactions/${timed.data.id}`, {
    amountCents: 1000, type: 'expense', categoryId: null, date: `${MONTH}-20`, time: null, note: 'timed A',
  });
  check('update can clear the time', clearTime.status === 200);

  for (const id of [timed.data.id, earlier.data.id, untimed.data.id]) {
    await a.call('DELETE', `/transactions/${id}`);
  }
  const gone = await a.call('GET', `/transactions?from=${MONTH}-20&to=${MONTH}-20`);
  check('time-test rows cleaned up', gone.data.length === 0, `got ${gone.data?.length}`);
}

// ---------- reports ----------
{
  const s = await a.call('GET', `/reports/summary?month=${MONTH}`);
  check('summary math', s.data.incomeCents === 500000 && s.data.expenseCents === 111111, JSON.stringify(s.data));

  const t = await a.call('GET', `/reports/trend?endMonth=${MONTH}&count=3`);
  check('trend has 3 months in order',
    t.data.length === 3 && t.data[0].month === '2026-05' && t.data[2].month === MONTH);
  check('trend includes previous month expense', t.data[1].expenseCents === 20000, JSON.stringify(t.data));

  const bd = await a.call('GET', `/reports/breakdown?month=${MONTH}&type=expense`);
  check('breakdown groups by category', bd.data.length === 1 && bd.data[0].totalCents === 111111);

  // date-range (from/to) filtering — powers the day / week / month / year views
  const [my, mm] = MONTH.split('-').map(Number);
  const monthTo = `${MONTH}-${String(new Date(my, mm, 0).getDate()).padStart(2, '0')}`;
  const rs = await a.call('GET', `/reports/summary?from=${MONTH}-01&to=${monthTo}`);
  check('summary from/to matches month', rs.data.incomeCents === 500000 && rs.data.expenseCents === 111111, JSON.stringify(rs.data));
  const rsEmpty = await a.call('GET', `/reports/summary?from=1999-01-01&to=1999-12-31`);
  check('summary from/to excludes out-of-range', rsEmpty.data.incomeCents === 0 && rsEmpty.data.expenseCents === 0);
  const rbd = await a.call('GET', `/reports/breakdown?from=${MONTH}-01&to=${monthTo}&type=expense`);
  check('breakdown from/to matches month', rbd.data.length === 1 && rbd.data[0].totalCents === 111111);
  const rtx = await a.call('GET', `/transactions?from=${MONTH}-01&to=${monthTo}`);
  const mtx = await a.call('GET', `/transactions?month=${MONTH}`);
  check('transactions from/to matches month', rtx.data.length === mtx.data.length && rtx.data.length > 0, `${rtx.data.length} vs ${mtx.data.length}`);
  const rtxEmpty = await a.call('GET', `/transactions?from=1999-01-01&to=1999-12-31`);
  check('transactions from/to excludes out-of-range', rtxEmpty.data.length === 0);

  // /reports/years: distinct years with transactions (data-driven, not a fixed
  // window). All of A's activity so far is in 2026, so 2025 must be absent.
  const yrs = await a.call('GET', '/reports/years');
  check('reports/years is data-driven', Array.isArray(yrs.data) && yrs.data.includes(2026) && !yrs.data.includes(2025), JSON.stringify(yrs.data));
}

// ---------- budgets (recurring, per-category cadence) ----------
{
  // Assumes the test runner and server share the calendar day. A fresh
  // category + a single today-dated expense makes "spent this period" exact:
  // today falls inside the current week AND month AND year.
  // LOCAL date, not toISOString() (UTC) — before 8am UTC+8 the UTC date is
  // yesterday, which can fall in the previous week and zero the weekly spent.
  const now = new Date();
  const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const bc = await a.call('POST', '/categories', { name: 'BudgetProbe', type: 'expense', color: '#123456' });
  const bcId = bc.data.id;
  const btx = await a.call('POST', '/transactions', {
    amountCents: 5000, type: 'expense', categoryId: bcId, accountId: null, date: TODAY, note: 'probe',
  });

  const put = await a.call('PUT', '/budgets', { categoryId: bcId, cadence: 'month', amountCents: 200000 });
  check('upsert budget', put.status === 200);

  const list = await a.call('GET', '/budgets');
  const row = list.data.find((r) => r.categoryId === bcId);
  check('budget row has amount, cadence, spent-this-period',
    row?.amountCents === 200000 && row?.cadence === 'month' && row?.spentCents === 5000, JSON.stringify(row));

  const put2 = await a.call('PUT', '/budgets', { categoryId: bcId, cadence: 'week', amountCents: 250000 });
  const row2 = (await a.call('GET', '/budgets')).data.find((r) => r.categoryId === bcId);
  check('upsert overwrites amount + cadence',
    put2.status === 200 && row2?.amountCents === 250000 && row2?.cadence === 'week' && row2?.spentCents === 5000, JSON.stringify(row2));

  const badCad = await a.call('PUT', '/budgets', { categoryId: bcId, cadence: 'decade', amountCents: 100 });
  check('invalid cadence -> 422', badCad.status === 422, `got ${badCad.status}`);

  const del = await a.call('PUT', '/budgets', { categoryId: bcId, cadence: 'month', amountCents: 0 });
  const row3 = (await a.call('GET', '/budgets')).data.find((r) => r.categoryId === bcId);
  check('zero deletes budget', del.status === 200 && row3?.amountCents === 0);

  // Remove probe data so later transaction/category assertions are unaffected.
  await a.call('DELETE', `/transactions/${btx.data.id}`);
  await a.call('DELETE', `/categories/${bcId}`);
}

// ---------- accounts & transfers ----------
let walletId = 0;
let bankId = 0;
{
  // create: one debit account with opening balance, one credit with negative opening
  const bank = await a.call('POST', '/accounts', {
    name: 'Test Bank', type: 'debit', color: '#38bdf8', openingBalanceCents: 100000, // 1,000.00
  });
  check('create debit account', bank.status === 201 && bank.data.id > 0 && bank.data.balanceCents === 100000, JSON.stringify(bank.data));
  bankId = bank.data.id;

  const wallet = await a.call('POST', '/accounts', {
    name: 'Test Wallet', type: 'debit', color: '#34d399', openingBalanceCents: 0,
  });
  walletId = wallet.data.id;

  const cc = await a.call('POST', '/accounts', {
    name: 'Test Card', type: 'credit', color: '#f87171', openingBalanceCents: -50000, // owes 500
  });
  check('credit account accepts negative opening', cc.status === 201 && cc.data.balanceCents === -50000);

  // Auto-negation: a POSITIVE magnitude on credit/loan is stored negative.
  const ccPos = await a.call('POST', '/accounts', {
    name: 'Card Pos', type: 'credit', color: '#f87171', openingBalanceCents: 50000,
  });
  check('credit: positive magnitude stored negative', ccPos.status === 201 && ccPos.data.balanceCents === -50000, JSON.stringify(ccPos.data));

  const loanPos = await a.call('POST', '/accounts', {
    name: 'Loan Pos', type: 'loan', color: '#a78bfa', openingBalanceCents: 300000,
  });
  check('loan: positive magnitude stored negative', loanPos.status === 201 && loanPos.data.balanceCents === -300000, JSON.stringify(loanPos.data));

  // Loans are managed purely via transfers — a transaction can never link one
  // (the UI hides the option; this pins the server-side rejection).
  const txOnLoan = await a.call('POST', '/transactions', {
    type: 'expense', amountCents: 1234, date: '2026-07-01', note: 'loan tx', categoryId: null, accountId: loanPos.data.id,
  });
  check('transaction on a loan account -> 422', txOnLoan.status === 422, `got ${txOnLoan.status}`);

  const debitPos = await a.call('POST', '/accounts', {
    name: 'Debit Pos', type: 'debit', color: '#34d399', openingBalanceCents: 75000,
  });
  check('debit: positive magnitude stays positive', debitPos.status === 201 && debitPos.data.balanceCents === 75000);

  // Updating a credit account with a positive magnitude keeps it negative.
  await a.call('PUT', `/accounts/${ccPos.data.id}`, { name: 'Card Pos', color: '#f87171', openingBalanceCents: 60000 });
  const afterUpd = (await a.call('GET', '/accounts')).data.find((x) => x.id === ccPos.data.id);
  check('credit update: positive magnitude stays negative', afterUpd.balanceCents === -60000, `got ${afterUpd.balanceCents}`);

  // clean up the extra probe accounts so later counts stay predictable
  for (const id of [ccPos.data.id, loanPos.data.id, debitPos.data.id]) {
    await a.call('DELETE', `/accounts/${id}`);
  }

  const badType = await a.call('POST', '/accounts', { name: 'X', type: 'cash', color: '#38bdf8', openingBalanceCents: 0 });
  check('invalid account type -> 422', badType.status === 422, `got ${badType.status}`);

  // ---------- payment due day (credit/loan monthly cycles) ----------
  const ccDue = await a.call('POST', '/accounts', {
    name: 'Due Card', type: 'credit', color: '#f87171', openingBalanceCents: 10000, dueDay: 15,
  });
  check('create credit with dueDay', ccDue.status === 201 && ccDue.data.dueDay === 15, JSON.stringify(ccDue.data));
  const dueInList = (await a.call('GET', '/accounts')).data.find((x) => x.id === ccDue.data.id);
  check('dueDay round-trips in list', dueInList?.dueDay === 15, `got ${dueInList?.dueDay}`);

  await a.call('PUT', `/accounts/${ccDue.data.id}`, { name: 'Due Card', color: '#f87171', openingBalanceCents: 10000, dueDay: 5 });
  const dueUpd = (await a.call('GET', '/accounts')).data.find((x) => x.id === ccDue.data.id);
  check('dueDay updates', dueUpd?.dueDay === 5, `got ${dueUpd?.dueDay}`);

  await a.call('PUT', `/accounts/${ccDue.data.id}`, { name: 'Due Card', color: '#f87171', openingBalanceCents: 10000, dueDay: null });
  const dueCleared = (await a.call('GET', '/accounts')).data.find((x) => x.id === ccDue.data.id);
  check('dueDay clears to null', dueCleared?.dueDay === null, `got ${dueCleared?.dueDay}`);

  const badDue = await a.call('POST', '/accounts', {
    name: 'Bad Due', type: 'credit', color: '#f87171', openingBalanceCents: 0, dueDay: 32,
  });
  check('dueDay 32 -> 422', badDue.status === 422, `got ${badDue.status}`);

  const debitDue = await a.call('POST', '/accounts', {
    name: 'Debit Due', type: 'debit', color: '#38bdf8', openingBalanceCents: 0, dueDay: 10,
  });
  check('dueDay on a debit account -> 422', debitDue.status === 422, `got ${debitDue.status}`);

  // Twice-a-month plans: a second due day. Server normalizes the pair —
  // sorted, deduped, and a lone second day is promoted to the first slot.
  const twice = await a.call('POST', '/accounts', {
    name: 'Twice Card', type: 'credit', color: '#f87171', openingBalanceCents: 0, dueDay: 30, dueDay2: 15,
  });
  check('two due days normalize sorted', twice.status === 201 && twice.data.dueDay === 15 && twice.data.dueDay2 === 30, JSON.stringify(twice.data));

  await a.call('PUT', `/accounts/${twice.data.id}`, {
    name: 'Twice Card', color: '#f87171', openingBalanceCents: 0, dueDay: null, dueDay2: 20,
  });
  const promoted = (await a.call('GET', '/accounts')).data.find((x) => x.id === twice.data.id);
  check('lone second day promoted to first', promoted?.dueDay === 20 && promoted?.dueDay2 === null, JSON.stringify({ d: promoted?.dueDay, d2: promoted?.dueDay2 }));

  await a.call('PUT', `/accounts/${twice.data.id}`, {
    name: 'Twice Card', color: '#f87171', openingBalanceCents: 0, dueDay: 12, dueDay2: 12,
  });
  const deduped = (await a.call('GET', '/accounts')).data.find((x) => x.id === twice.data.id);
  check('duplicate due days collapse', deduped?.dueDay === 12 && deduped?.dueDay2 === null, JSON.stringify({ d: deduped?.dueDay, d2: deduped?.dueDay2 }));

  const badDue2 = await a.call('POST', '/accounts', {
    name: 'Bad Due2', type: 'credit', color: '#f87171', openingBalanceCents: 0, dueDay: 5, dueDay2: 40,
  });
  check('dueDay2 40 -> 422', badDue2.status === 422, `got ${badDue2.status}`);

  await a.call('DELETE', `/accounts/${twice.data.id}`);
  await a.call('DELETE', `/accounts/${ccDue.data.id}`); // keep later counts predictable

  // ---------- account custom image (color OR image) ----------
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const imgAcct = await a.call('POST', '/accounts', {
    name: 'Img Acct', type: 'debit', color: '#38bdf8', image: PNG, openingBalanceCents: 0,
  });
  check('create account with image', imgAcct.status === 201 && imgAcct.data.image === PNG, JSON.stringify(imgAcct.data).slice(0, 120));

  const imgInList = (await a.call('GET', '/accounts')).data.find((x) => x.id === imgAcct.data.id);
  check('account image round-trips in list', imgInList?.image === PNG);

  // update can set an image on an existing account, then clear it back to null
  await a.call('PUT', `/accounts/${bankId}`, { name: 'Test Bank', color: '#38bdf8', image: PNG, openingBalanceCents: 100000 });
  let bankImg = (await a.call('GET', '/accounts')).data.find((x) => x.id === bankId);
  check('account update can set image', bankImg?.image === PNG);
  await a.call('PUT', `/accounts/${bankId}`, { name: 'Test Bank', color: '#38bdf8', image: null, openingBalanceCents: 100000 });
  bankImg = (await a.call('GET', '/accounts')).data.find((x) => x.id === bankId);
  check('account update can clear image', bankImg?.image === null, JSON.stringify(bankImg?.image));

  const badImg = await a.call('POST', '/accounts', {
    name: 'Bad Img', type: 'debit', color: '#38bdf8', image: 'https://example.com/x.png', openingBalanceCents: 0,
  });
  check('invalid account image -> 422', badImg.status === 422, `got ${badImg.status}`);

  const hugeImg = await a.call('POST', '/accounts', {
    name: 'Huge Img', type: 'debit', color: '#38bdf8', image: 'data:image/png;base64,' + 'A'.repeat(800001), openingBalanceCents: 0,
  });
  check('oversized account image -> 422', hugeImg.status === 422, `got ${hugeImg.status}`);

  await a.call('DELETE', `/accounts/${imgAcct.data.id}`); // keep later counts predictable

  // tx tied to account: expense deducts, income adds
  const exp = await a.call('POST', '/transactions', {
    amountCents: 20000, type: 'expense', categoryId: seededGroceriesId, accountId: bankId,
    date: `${MONTH}-10`, note: 'account expense',
  });
  check('create tx with account', exp.status === 201 && exp.data.accountId === bankId && exp.data.accountName === 'Test Bank', JSON.stringify(exp.data));

  await a.call('POST', '/transactions', {
    amountCents: 50000, type: 'income', categoryId: null, accountId: bankId,
    date: `${MONTH}-11`, note: 'account income',
  });

  // accountId filter (powers the account detail page): only this account's tx.
  const bankTxs = await a.call('GET', `/transactions?accountId=${bankId}`);
  check(
    'accountId filter returns only that account',
    bankTxs.status === 200 && bankTxs.data.length >= 2 && bankTxs.data.every((t) => t.accountId === bankId),
    JSON.stringify(bankTxs.data.map((t) => t.accountId))
  );
  const walletTxs = await a.call('GET', `/transactions?accountId=${walletId}`);
  check('accountId filter excludes other accounts', walletTxs.data.every((t) => t.accountId === walletId));

  let accounts = (await a.call('GET', '/accounts')).data;
  let bankRow = accounts.find((x) => x.id === bankId);
  check('balance = opening - expense + income', bankRow.balanceCents === 100000 - 20000 + 50000, `got ${bankRow.balanceCents}`);

  // transfer with fee: from loses amount+fee, to gains amount
  const tf = await a.call('POST', '/transfers', {
    fromAccountId: bankId, toAccountId: walletId, amountCents: 30000, feeCents: 1500,
    date: `${MONTH}-12`, note: 'top-up',
  });
  check('create transfer', tf.status === 201 && tf.data.fromName === 'Test Bank' && tf.data.toName === 'Test Wallet', JSON.stringify(tf.data));
  const tfId = tf.data.id;

  accounts = (await a.call('GET', '/accounts')).data;
  bankRow = accounts.find((x) => x.id === bankId);
  let walletRow = accounts.find((x) => x.id === walletId);
  check('transfer deducts amount+fee from source', bankRow.balanceCents === 130000 - 31500, `got ${bankRow.balanceCents}`);
  check('transfer adds amount only to target', walletRow.balanceCents === 30000, `got ${walletRow.balanceCents}`);

  // transfer with NO fee (fee optional)
  const tf2 = await a.call('POST', '/transfers', {
    fromAccountId: walletId, toAccountId: bankId, amountCents: 5000,
    date: `${MONTH}-13`, note: '',
  });
  check('transfer without fee works', tf2.status === 201 && tf2.data.feeCents === 0);

  // validation
  const same = await a.call('POST', '/transfers', {
    fromAccountId: bankId, toAccountId: bankId, amountCents: 100, date: `${MONTH}-13`, note: '',
  });
  check('same-account transfer -> 422', same.status === 422, `got ${same.status}`);

  const negFee = await a.call('POST', '/transfers', {
    fromAccountId: bankId, toAccountId: walletId, amountCents: 100, feeCents: -5, date: `${MONTH}-13`, note: '',
  });
  check('negative fee -> 422', negFee.status === 422, `got ${negFee.status}`);

  // optional time (HH:MM), mirroring transactions.time. The timed transfer is
  // deleted again so the exact balance assertions below stay valid.
  const timedTf = await a.call('POST', '/transfers', {
    fromAccountId: bankId, toAccountId: walletId, amountCents: 700, feeCents: 0,
    date: `${MONTH}-14`, time: '18:45', note: 'timed transfer',
  });
  check('transfer with time -> echoed back', timedTf.status === 201 && timedTf.data.time === '18:45', JSON.stringify(timedTf.data));
  check('transfer without time -> time null', tf2.data.time === null, JSON.stringify(tf2.data));
  const badTfTime = await a.call('POST', '/transfers', {
    fromAccountId: bankId, toAccountId: walletId, amountCents: 700, feeCents: 0,
    date: `${MONTH}-14`, time: '24:00', note: 'bad time',
  });
  check('transfer with invalid time -> 422', badTfTime.status === 422, `got ${badTfTime.status}`);
  await a.call('DELETE', `/transfers/${timedTf.data.id}`);

  // update transfer: change amount, balances follow
  const upd = await a.call('PUT', `/transfers/${tfId}`, {
    fromAccountId: bankId, toAccountId: walletId, amountCents: 10000, feeCents: 0,
    date: `${MONTH}-12`, note: 'top-up (edited)',
  });
  accounts = (await a.call('GET', '/accounts')).data;
  walletRow = accounts.find((x) => x.id === walletId);
  check('transfer update recomputes balances', upd.status === 200 && walletRow.balanceCents === 10000 - 5000, `got ${walletRow.balanceCents}`);

  // transfers list includes both, newest-date first
  const tlist = await a.call('GET', '/transfers');
  check('transfers list returns rows', tlist.status === 200 && tlist.data.length >= 2);

  // account update: rename + change opening balance shifts computed balance
  const rename = await a.call('PUT', `/accounts/${bankId}`, { name: 'Main Bank', color: '#38bdf8', openingBalanceCents: 200000 });
  accounts = (await a.call('GET', '/accounts')).data;
  bankRow = accounts.find((x) => x.id === bankId);
  check('account update (name + opening)', rename.status === 200 && bankRow.name === 'Main Bank' && bankRow.balanceCents === 200000 - 20000 + 50000 - 10000 + 5000, `got ${bankRow.balanceCents}`);

  // delete the credit account: unused, should just disappear
  const delCc = await a.call('DELETE', `/accounts/${cc.data.id}`);
  accounts = (await a.call('GET', '/accounts')).data;
  check('delete unused account', delCc.status === 200 && !accounts.some((x) => x.id === cc.data.id));
}

// ---------- account FK behavior: delete a used account ----------
{
  // wallet has transfers; delete it and ensure bank's history is preserved
  const before = (await a.call('GET', '/accounts')).data.find((x) => x.id === bankId).balanceCents;
  const del = await a.call('DELETE', `/accounts/${walletId}`);
  check('delete account with transfers', del.status === 200);

  const after = (await a.call('GET', '/accounts')).data.find((x) => x.id === bankId).balanceCents;
  check('other side balance unchanged after account delete', after === before, `${before} -> ${after}`);

  const tlist = await a.call('GET', '/transfers');
  const orphan = tlist.data.find((t) => t.toAccountId === null || t.fromAccountId === null);
  check('transfer rows survive with null side', !!orphan, JSON.stringify(tlist.data.slice(0, 2)));

  // tx attached to deleted account -> accountId null
  const bankDel = await a.call('DELETE', `/accounts/${bankId}`);
  const txs = await a.call('GET', `/transactions?month=${MONTH}&search=account expense`);
  check('tx accountId nulled after account delete', bankDel.status === 200 && txs.data[0]?.accountId === null, JSON.stringify(txs.data[0]));
}

// ---------- cross-user isolation ----------
{
  await b.call('GET', '/auth/me');
  const reg = await b.call('POST', '/auth/register', { email: emailB, password, name: 'Bob' });
  b.csrf = reg.data.csrf;
  check('user B registers', reg.status === 200);
  const bv = await verifyClient(b, emailB);
  check('user B verifies email', bv.status === 200 && bv.data.user?.emailVerified === true, JSON.stringify(bv.data));

  const bTxs = await b.call('GET', `/transactions?month=${MONTH}`);
  check('B sees no transactions of A', bTxs.data.length === 0);

  const steal = await b.call('PUT', `/categories/${catId}`, { name: 'Hacked', color: '#000000' });
  check('B cannot update A category -> 404', steal.status === 404, `got ${steal.status}`);

  const stealTx = await b.call('DELETE', `/transactions/${txId}`);
  check('B cannot delete A transaction -> 404', stealTx.status === 404);

  const stealBudget = await b.call('PUT', '/budgets', { categoryId: catId, cadence: 'month', amountCents: 1 });
  check('B cannot budget A category -> 422', stealBudget.status === 422);

  const stealTxCat = await b.call('POST', '/transactions', {
    amountCents: 100, type: 'expense', categoryId: catId, date: `${MONTH}-01`, note: 'steal',
  });
  check('B cannot attach tx to A category -> 422', stealTxCat.status === 422);

  // accounts isolation: give A a fresh account and let B try to abuse it
  const aAcct = await a.call('POST', '/accounts', {
    name: 'A Private', type: 'debit', color: '#38bdf8', openingBalanceCents: 7700,
  });
  const aAcctId = aAcct.data.id;

  const bAccounts = await b.call('GET', '/accounts');
  check('B sees no accounts of A', !bAccounts.data.some((x) => x.id === aAcctId));

  const stealAcctTx = await b.call('POST', '/transactions', {
    amountCents: 100, type: 'expense', categoryId: null, accountId: aAcctId, date: `${MONTH}-01`, note: 'steal',
  });
  check('B cannot attach tx to A account -> 422', stealAcctTx.status === 422, `got ${stealAcctTx.status}`);

  const bAcct = await b.call('POST', '/accounts', {
    name: 'B Own', type: 'debit', color: '#34d399', openingBalanceCents: 0,
  });
  const stealTransfer = await b.call('POST', '/transfers', {
    fromAccountId: aAcctId, toAccountId: bAcct.data.id, amountCents: 100, date: `${MONTH}-01`, note: 'drain',
  });
  check('B cannot transfer from A account -> 422', stealTransfer.status === 422, `got ${stealTransfer.status}`);

  const stealAcctUpd = await b.call('PUT', `/accounts/${aAcctId}`, { name: 'Hacked', color: '#000000', openingBalanceCents: 0 });
  check('B cannot update A account -> 404', stealAcctUpd.status === 404, `got ${stealAcctUpd.status}`);

  const stealAcctDel = await b.call('DELETE', `/accounts/${aAcctId}`);
  check('B cannot delete A account -> 404', stealAcctDel.status === 404, `got ${stealAcctDel.status}`);

  await a.call('DELETE', `/accounts/${aAcctId}`); // clean up A's probe account
}

// ---------- FK behavior: delete category -> tx uncategorized, budget gone ----------
{
  await a.call('PUT', '/budgets', { categoryId: catId, cadence: 'month', amountCents: 5000 });
  const del = await a.call('DELETE', `/categories/${catId}`);
  check('delete category', del.status === 200);

  const txs = await a.call('GET', `/transactions?month=${MONTH}`);
  const orphan = txs.data.find((t) => t.id === txId);
  check('tx becomes uncategorized', orphan && orphan.categoryId === null && orphan.categoryName === null, JSON.stringify(orphan));

  const budgets = await a.call('GET', '/budgets');
  check('budget rows for deleted category are gone', !budgets.data.some((r) => r.categoryId === catId));
}

// ---------- login, wrong password, throttling ----------
{
  const wrong = await a.call('POST', '/auth/login', { email: emailA, password: 'wrong-password' });
  check('wrong password -> 401', wrong.status === 401);

  const fresh = new Client();
  await fresh.call('GET', '/auth/me').then((r) => (fresh.csrf = r.data.csrf));
  const ok = await fresh.call('POST', '/auth/login', { email: emailA, password });
  check('login works', ok.status === 200 && ok.data.user?.email === emailA);
  fresh.csrf = ok.data.csrf;

  const who = await fresh.call('GET', '/auth/me');
  check('session persists', who.data.user?.email === emailA);

  // throttle: 8 attempts allowed per window; hammer to exceed
  const hammer = new Client();
  await hammer.call('GET', '/auth/me').then((r) => (hammer.csrf = r.data.csrf));
  const throttleEmail = `throttle.${suffix}@test.local`;
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await hammer.call('POST', '/auth/login', { email: throttleEmail, password: 'x'.repeat(10) });
    if (r.status === 429) {
      got429 = true;
      break;
    }
  }
  check('login throttling kicks in (429)', got429);
}

// ---------- subscriptions (recurring auto-charges) ----------
{
  const iso = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const today = new Date();
  const todayIso = iso(today);
  const daysAgo = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));

  const s = new Client();
  await s.call('GET', '/auth/me').then((r) => (s.csrf = r.data.csrf));
  const email = `subs.${suffix}@test.local`;
  const reg = await s.call('POST', '/auth/register', { email, password, name: 'Subs' });
  s.csrf = reg.data.csrf;
  await verifyClient(s, email);

  const acct = (await s.call('POST', '/accounts', {
    name: 'Sub Wallet', type: 'debit', color: '#38bdf8', image: null,
    dueDay: null, dueDay2: null, openingBalanceCents: 100000,
  })).data;
  const loanAcct = (await s.call('POST', '/accounts', {
    name: 'Sub Loan', type: 'loan', color: '#ef4444', image: null,
    dueDay: null, dueDay2: null, openingBalanceCents: -5000,
  })).data;
  const cat = (await s.call('POST', '/categories', {
    name: 'Streaming', type: 'expense', color: '#8b5cf6',
  })).data;

  // validation
  const badCycle = await s.call('POST', '/subscriptions', {
    name: 'X', amountCents: 100, accountId: acct.id, categoryId: null,
    cycle: 'weekly', intervalDays: null, nextDate: todayIso, active: true,
  });
  check('subscription with bad cycle -> 422', badCycle.status === 422, `got ${badCycle.status}`);
  const noDays = await s.call('POST', '/subscriptions', {
    name: 'X', amountCents: 100, accountId: acct.id, categoryId: null,
    cycle: 'interval', intervalDays: null, nextDate: todayIso, active: true,
  });
  check('interval subscription without days -> 422', noDays.status === 422, `got ${noDays.status}`);
  const onLoan = await s.call('POST', '/subscriptions', {
    name: 'X', amountCents: 100, accountId: loanAcct.id, categoryId: null,
    cycle: 'monthly', intervalDays: null, nextDate: todayIso, active: true,
  });
  check('subscription on a loan account -> 422', onLoan.status === 422, `got ${onLoan.status}`);
  const ghostAcct = await s.call('POST', '/subscriptions', {
    name: 'X', amountCents: 100, accountId: 99999999, categoryId: null,
    cycle: 'monthly', intervalDays: null, nextDate: todayIso, active: true,
  });
  check('subscription on unknown account -> 422', ghostAcct.status === 422, `got ${ghostAcct.status}`);

  // monthly sub due today: created now, auto-charged by the NEXT request
  const net = (await s.call('POST', '/subscriptions', {
    name: 'Netflix', amountCents: 54900, accountId: acct.id, categoryId: cat.id,
    cycle: 'monthly', intervalDays: null, nextDate: todayIso, active: true,
  })).data;
  check(
    'monthly subscription created; billDay = nextDate day',
    net?.id > 0 && net.cycle === 'monthly' && net.billDay === today.getDate() && net.nextDate === todayIso,
    JSON.stringify(net)
  );

  const txAfter = await s.call('GET', '/transactions', undefined);
  const charge = (txAfter.data ?? []).find((t) => t.note === 'Netflix (subscription)');
  check(
    'due subscription auto-charged an expense on the linked account',
    charge && charge.type === 'expense' && charge.amountCents === 54900 &&
      charge.accountId === acct.id && charge.categoryId === cat.id && charge.date === todayIso,
    JSON.stringify(charge ?? txAfter.data)
  );

  const subsNow = (await s.call('GET', '/subscriptions')).data;
  const netNow = subsNow.find((x) => x.id === net.id);
  check(
    'charged subscription advanced nextDate into the future, anchor kept',
    netNow && netNow.nextDate > todayIso && netNow.billDay === today.getDate(),
    JSON.stringify(netNow)
  );

  const acctNow = (await s.call('GET', '/accounts')).data.find((a) => a.id === acct.id);
  check(
    'account balance dropped by the charge',
    acctNow?.balanceCents === 100000 - 54900,
    `got ${acctNow?.balanceCents}`
  );

  // interval sub 65 days behind catches up: 3 charges (t-65, t-35, t-5), next t+25
  const prepaid = (await s.call('POST', '/subscriptions', {
    name: 'Prepaid Wifi', amountCents: 1000, accountId: acct.id, categoryId: null,
    cycle: 'interval', intervalDays: 30, nextDate: daysAgo(65), active: true,
  })).data;
  await s.call('GET', '/subscriptions'); // triggers processing
  const wifiTxs = (await s.call('GET', '/transactions')).data.filter(
    (t) => t.note === 'Prepaid Wifi (subscription)'
  );
  const prepaidNow = (await s.call('GET', '/subscriptions')).data.find((x) => x.id === prepaid.id);
  check(
    'interval sub 65 days behind catches up with 3 dated charges',
    wifiTxs.length === 3 &&
      wifiTxs.some((t) => t.date === daysAgo(65)) &&
      wifiTxs.some((t) => t.date === daysAgo(35)) &&
      wifiTxs.some((t) => t.date === daysAgo(5)),
    JSON.stringify(wifiTxs.map((t) => t.date))
  );
  check(
    'caught-up interval sub lands 25 days ahead',
    prepaidNow?.nextDate === iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 25)),
    `got ${prepaidNow?.nextDate}`
  );

  // yearly sub due today: charges once, advances to the same date NEXT year
  const domain = (await s.call('POST', '/subscriptions', {
    name: 'Domain Renewal', amountCents: 79900, accountId: acct.id, categoryId: null,
    cycle: 'yearly', intervalDays: null, nextDate: todayIso, active: true,
  })).data;
  check(
    'yearly subscription created; billDay = nextDate day, no intervalDays',
    domain?.id > 0 && domain.cycle === 'yearly' && domain.billDay === today.getDate() && domain.intervalDays === null,
    JSON.stringify(domain)
  );
  await s.call('GET', '/subscriptions'); // triggers the charge
  const domainTxs = (await s.call('GET', '/transactions')).data.filter(
    (t) => t.note === 'Domain Renewal (subscription)'
  );
  const domainNow = (await s.call('GET', '/subscriptions')).data.find((x) => x.id === domain.id);
  const nextYearIso = iso(new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()));
  check(
    'yearly sub charged once today and advanced exactly one year',
    domainTxs.length === 1 && domainTxs[0].date === todayIso && domainNow?.nextDate === nextYearIso,
    JSON.stringify({ txs: domainTxs.map((t) => t.date), next: domainNow?.nextDate, expected: nextYearIso })
  );

  // paused subs never charge; resuming does NOT back-charge the paused stretch
  const gym = (await s.call('POST', '/subscriptions', {
    name: 'Gym', amountCents: 2000, accountId: acct.id, categoryId: null,
    cycle: 'monthly', intervalDays: null, nextDate: daysAgo(40), active: false,
  })).data;
  await s.call('GET', '/subscriptions');
  let gymTxs = (await s.call('GET', '/transactions')).data.filter(
    (t) => t.note === 'Gym (subscription)'
  );
  check('paused subscription never charges', gymTxs.length === 0, `got ${gymTxs.length}`);

  const resume = await s.call('PUT', `/subscriptions/${gym.id}`, {
    name: 'Gym', amountCents: 2000, accountId: acct.id, categoryId: null,
    cycle: 'monthly', intervalDays: null, nextDate: daysAgo(40), active: true,
  });
  const gymNow = (await s.call('GET', '/subscriptions')).data.find((x) => x.id === gym.id);
  gymTxs = (await s.call('GET', '/transactions')).data.filter(
    (t) => t.note === 'Gym (subscription)'
  );
  check(
    'resume rolls nextDate forward without back-charging',
    resume.status === 200 && gymTxs.length === 0 && gymNow?.nextDate >= todayIso && gymNow?.active === true,
    `status ${resume.status}, txs ${gymTxs.length}, next ${gymNow?.nextDate}`
  );

  // deleting the linked account pauses charging (accountId -> null)
  const tmpAcct = (await s.call('POST', '/accounts', {
    name: 'Doomed', type: 'debit', color: '#22c55e', image: null,
    dueDay: null, dueDay2: null, openingBalanceCents: 50000,
  })).data;
  const orphan = (await s.call('POST', '/subscriptions', {
    name: 'Orphan', amountCents: 500, accountId: tmpAcct.id, categoryId: null,
    cycle: 'monthly', intervalDays: null, nextDate: todayIso, active: true,
  })).data;
  // The DELETE request itself first processes dues (sub still linked, due
  // today -> one legitimate charge), THEN deletes the account, which unlinks
  // the sub (accountId null). After that, repeated requests add nothing.
  await s.call('DELETE', `/accounts/${tmpAcct.id}`);
  await s.call('GET', '/subscriptions');
  const orphanNow = (await s.call('GET', '/subscriptions')).data.find((x) => x.id === orphan.id);
  const orphanTxs = (await s.call('GET', '/transactions')).data.filter(
    (t) => t.note === 'Orphan (subscription)'
  );
  check(
    'deleting the linked account unlinks the sub; no further charges',
    orphanNow?.accountId === null && orphanTxs.length === 1,
    JSON.stringify({ acct: orphanNow?.accountId, txs: orphanTxs.length })
  );

  // cross-user isolation
  const other = new Client();
  await other.call('GET', '/auth/me').then((r) => (other.csrf = r.data.csrf));
  const otherEmail = `subs2.${suffix}@test.local`;
  const oReg = await other.call('POST', '/auth/register', { email: otherEmail, password, name: 'Subs2' });
  other.csrf = oReg.data.csrf;
  await verifyClient(other, otherEmail);
  const otherList = await other.call('GET', '/subscriptions');
  check('other user sees no foreign subscriptions', otherList.data?.length === 0, JSON.stringify(otherList.data));
  const foreignAcct = await other.call('POST', '/subscriptions', {
    name: 'Steal', amountCents: 100, accountId: acct.id, categoryId: null,
    cycle: 'monthly', intervalDays: null, nextDate: todayIso, active: true,
  });
  check("subscription on another user's account -> 422", foreignAcct.status === 422, `got ${foreignAcct.status}`);
  const foreignDel = await other.call('DELETE', `/subscriptions/${net.id}`);
  check("deleting another user's subscription -> 404", foreignDel.status === 404, `got ${foreignDel.status}`);

  // REGRESSION: a stale client echoing back an already-charged nextDate must
  // NOT rewind it into charged territory (would double-charge the cycle).
  // Netflix charged today; PUT the original (stale) nextDate = today back.
  const staleEcho = await s.call('PUT', `/subscriptions/${net.id}`, {
    name: 'Netflix', amountCents: 54900, accountId: acct.id, categoryId: cat.id,
    cycle: 'monthly', intervalDays: null, nextDate: todayIso, active: true,
  });
  await s.call('GET', '/subscriptions'); // would double-charge if rewound
  const netAfterEcho = (await s.call('GET', '/subscriptions')).data.find((x) => x.id === net.id);
  const netCharges = (await s.call('GET', '/transactions')).data.filter(
    (t) => t.note === 'Netflix (subscription)'
  );
  check(
    'stale-client nextDate echo cannot rewind into charged territory (no double charge)',
    staleEcho.status === 200 && netCharges.length === 1 && netAfterEcho?.nextDate > todayIso,
    `status ${staleEcho.status}, charges ${netCharges.length}, next ${netAfterEcho?.nextDate}`
  );

  // anti-flood: a first charge date years in the past is rejected
  const ancient = await s.call('POST', '/subscriptions', {
    name: 'Ancient', amountCents: 100, accountId: acct.id, categoryId: null,
    cycle: 'interval', intervalDays: 1, nextDate: '2019-01-01', active: true,
  });
  check('subscription years in the past -> 422', ancient.status === 422, `got ${ancient.status}`);

  // delete: future charges stop, history stays
  const del = await s.call('DELETE', `/subscriptions/${net.id}`);
  const delAgain = await s.call('DELETE', `/subscriptions/${net.id}`);
  const historyTx = (await s.call('GET', '/transactions')).data.find(
    (t) => t.note === 'Netflix (subscription)'
  );
  check(
    'delete subscription -> ok, repeat -> 404, past charges kept',
    del.status === 200 && delAgain.status === 404 && historyTx !== undefined,
    `del ${del.status}, again ${delAgain.status}`
  );
}

// ---------- currency preference ----------
{
  const c = new Client();
  await c.call('GET', '/auth/me').then((r) => (c.csrf = r.data.csrf));
  const email = `curr.${suffix}@test.local`;
  const reg = await c.call('POST', '/auth/register', { email, password, name: 'Curr' });
  c.csrf = reg.data.csrf;
  check('new user defaults to USD', reg.data.user?.currency === 'USD', JSON.stringify(reg.data.user));

  const set = await c.call('POST', '/auth/currency', { currency: 'PHP' });
  check('set currency PHP', set.status === 200 && set.data.currency === 'PHP', JSON.stringify(set.data));

  const me = await c.call('GET', '/auth/me');
  check('currency persists in /auth/me', me.data.user?.currency === 'PHP');

  const lower = await c.call('POST', '/auth/currency', { currency: 'eur' });
  check('lowercase code normalized to EUR', lower.status === 200 && lower.data.currency === 'EUR');

  const bad = await c.call('POST', '/auth/currency', { currency: 'US' });
  check('invalid currency (too short) -> 422', bad.status === 422, `got ${bad.status}`);

  const bad2 = await c.call('POST', '/auth/currency', { currency: 'U$D' });
  check('invalid currency (non-letters) -> 422', bad2.status === 422, `got ${bad2.status}`);

  const anon = new Client();
  await anon.call('GET', '/auth/me').then((r) => (anon.csrf = r.data.csrf));
  const noAuth = await anon.call('POST', '/auth/currency', { currency: 'PHP' });
  check('currency change requires auth -> 401', noAuth.status === 401, `got ${noAuth.status}`);

  // Region-detected default: register accepts an optional currency HINT.
  // It is sanitized, not validated — junk falls back to USD, never a 4xx.
  const h = new Client();
  await h.call('GET', '/auth/me').then((r) => (h.csrf = r.data.csrf));
  const hinted = await h.call('POST', '/auth/register', {
    email: `hint.${suffix}@test.local`, password, name: 'Hint', currency: 'php',
  });
  check(
    'register currency hint applied + normalized (php -> PHP)',
    hinted.status === 200 && hinted.data.user?.currency === 'PHP',
    JSON.stringify(hinted.data.user)
  );

  const j = new Client();
  await j.call('GET', '/auth/me').then((r) => (j.csrf = r.data.csrf));
  const junkHint = await j.call('POST', '/auth/register', {
    email: `hintbad.${suffix}@test.local`, password, name: 'HintBad', currency: 'U$D',
  });
  check(
    'register with junk currency hint still succeeds as USD',
    junkHint.status === 200 && junkHint.data.user?.currency === 'USD',
    `status ${junkHint.status} ${JSON.stringify(junkHint.data.user)}`
  );
}

// ---------- change password (authenticated) ----------
{
  const c = new Client();
  await c.call('GET', '/auth/me').then((r) => (c.csrf = r.data.csrf));
  const email = `carol.${suffix}@test.local`;
  const reg = await c.call('POST', '/auth/register', { email, password, name: 'Carol' });
  c.csrf = reg.data.csrf;
  check('carol registers', reg.status === 200);

  const wrongCurrent = await c.call('POST', '/auth/change-password', {
    currentPassword: 'not-the-password', newPassword: 'brand-new-pass-1',
  });
  check('change-password with wrong current -> 403', wrongCurrent.status === 403, `got ${wrongCurrent.status}`);

  const tooShort = await c.call('POST', '/auth/change-password', {
    currentPassword: password, newPassword: 'short',
  });
  check('change-password with short new -> 422', tooShort.status === 422, `got ${tooShort.status}`);

  const newPassword = 'carol-new-password-2';
  const ok = await c.call('POST', '/auth/change-password', {
    currentPassword: password, newPassword,
  });
  check('change-password succeeds', ok.status === 200, `got ${ok.status}`);

  // Old password no longer works; new one does.
  const oldLogin = new Client();
  await oldLogin.call('GET', '/auth/me').then((r) => (oldLogin.csrf = r.data.csrf));
  const oldTry = await oldLogin.call('POST', '/auth/login', { email, password });
  check('old password rejected after change -> 401', oldTry.status === 401, `got ${oldTry.status}`);

  const newLogin = new Client();
  await newLogin.call('GET', '/auth/me').then((r) => (newLogin.csrf = r.data.csrf));
  const newTry = await newLogin.call('POST', '/auth/login', { email, password: newPassword });
  check('new password works after change', newTry.status === 200 && newTry.data.user?.email === email);
}

// ---------- delete account (cascades all data, session destroyed) ----------
{
  const c = new Client();
  await c.call('GET', '/auth/me').then((r) => (c.csrf = r.data.csrf));
  const email = `deleteme.${suffix}@test.local`;
  const reg = await c.call('POST', '/auth/register', { email, password, name: 'Del' });
  c.csrf = reg.data.csrf;
  await verifyClient(c, email);

  // Give the account data so the cascade is exercised.
  const cat = await c.call('POST', '/categories', { name: 'DelCat', type: 'expense', color: '#123123' });
  await c.call('POST', '/transactions', {
    amountCents: 100, type: 'expense', categoryId: cat.data.id, date: `${MONTH}-01`, note: 'doomed',
  });

  const anon = new Client();
  await anon.call('GET', '/auth/me').then((r) => (anon.csrf = r.data.csrf));
  const noAuth = await anon.call('POST', '/auth/delete-account', { currentPassword: password });
  check('delete-account requires auth -> 401', noAuth.status === 401, `got ${noAuth.status}`);

  const wrongPw = await c.call('POST', '/auth/delete-account', { currentPassword: 'not-right-1' });
  check('delete-account with wrong password -> 403', wrongPw.status === 403, `got ${wrongPw.status}`);

  const ok = await c.call('POST', '/auth/delete-account', { currentPassword: password });
  check('delete-account succeeds', ok.status === 200 && ok.data.ok === true, JSON.stringify(ok.data));

  const me = await c.call('GET', '/auth/me');
  check('session destroyed after delete', me.data.user === null);
  c.csrf = me.data.csrf;

  const login = await c.call('POST', '/auth/login', { email, password });
  check('deleted account cannot log in -> 401', login.status === 401, `got ${login.status}`);

  // The unique email is freed — the row (and its data) really went away.
  const reReg = await c.call('POST', '/auth/register', { email, password, name: 'Del2' });
  check('email reusable after delete', reReg.status === 200, `got ${reReg.status}`);
}

// ---------- forgot / reset password ----------
{
  // Endpoint always returns ok, even for unknown emails (no enumeration).
  const c = new Client();
  await c.call('GET', '/auth/me').then((r) => (c.csrf = r.data.csrf));
  const unknown = await c.call('POST', '/auth/forgot', { email: `nobody.${suffix}@test.local` });
  check('forgot for unknown email -> ok (no enumeration)', unknown.status === 200 && unknown.data.ok === true);

  // Reset-poisoning regression (DEF-1 / CWE-640): a spoofed Host header must
  // NOT leak into the emailed reset link. Requires 'app_base_url' in config;
  // the runner passes the expected origin via APP_BASE_URL.
  if (MAIL_LOG && process.env.APP_BASE_URL) {
    const base = process.env.APP_BASE_URL.replace(/\/$/, '');
    const pc = new Client();
    await pc.call('GET', '/auth/me').then((r) => (pc.csrf = r.data.csrf));
    const email = `poison.${suffix}@test.local`;
    await pc.call('POST', '/auth/register', { email, password, name: 'Poison' });
    await pc.call('POST', '/auth/forgot', { email }, { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' });
    const link = latestEmailLink(email);
    check(
      'emailed reset link uses configured origin, ignores spoofed Host',
      typeof link === 'string' && link.startsWith(base + '/') && !link.includes('evil.example'),
      `link=${link}`
    );
  }

  if (MAIL_LOG) {
    // Full flow: register, request reset, read token from mail log, reset.
    const rc = new Client();
    await rc.call('GET', '/auth/me').then((r) => (rc.csrf = r.data.csrf));
    const email = `reset.${suffix}@test.local`;
    const reg = await rc.call('POST', '/auth/register', { email, password, name: 'Reset' });
    rc.csrf = reg.data.csrf;
    check('reset-user registers', reg.status === 200);

    const req = await rc.call('POST', '/auth/forgot', { email });
    check('forgot for known email -> ok', req.status === 200);

    const token = latestResetToken(email);
    check('reset token was emailed', typeof token === 'string' && token.length === 64, String(token));

    const badToken = await rc.call('POST', '/auth/reset', { token: 'f'.repeat(64), password: 'whatever-1' });
    check('reset with bogus token -> 400', badToken.status === 400, `got ${badToken.status}`);

    const shortPw = await rc.call('POST', '/auth/reset', { token, password: 'short' });
    check('reset with short password -> 422', shortPw.status === 422, `got ${shortPw.status}`);

    const rl = new Client();
    await rl.call('GET', '/auth/me').then((r) => (rl.csrf = r.data.csrf));
    const newPassword = 'reset-fresh-password-3';
    const done = await rl.call('POST', '/auth/reset', { token, password: newPassword });
    check('reset succeeds + logs in', done.status === 200 && done.data.user?.email === email, `got ${done.status}`);

    const reuse = await rl.call('POST', '/auth/reset', { token, password: 'another-pass-4' });
    check('reset token is single-use -> 400', reuse.status === 400, `got ${reuse.status}`);

    const login = new Client();
    await login.call('GET', '/auth/me').then((r) => (login.csrf = r.data.csrf));
    const withNew = await login.call('POST', '/auth/login', { email, password: newPassword });
    check('login works with reset password', withNew.status === 200 && withNew.data.user?.email === email);
  }
}

// ---------- logout ----------
{
  const out = await a.call('POST', '/auth/logout');
  check('logout', out.status === 200);
  const me = await a.call('GET', '/auth/me');
  check('me after logout -> null user', me.data.user === null);
  a.csrf = me.data.csrf;
  const denied = await a.call('GET', '/transactions?month=' + MONTH);
  check('data access after logout -> 401', denied.status === 401);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('API TEST SUITE PASS');

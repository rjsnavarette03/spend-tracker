// Seeds a LOCAL demo user with made-up accounts and history shaped like a
// typical twice-a-month salary setup (bank, loans, pay-later card, utility
// bills), for trying the Schedule page. Refuses to run against anything but
// a local server.
//
//   node scripts/seed-demo.mjs
//   API_BASE=http://127.0.0.1:8124 MAIL_LOG=deploy/api/app/maillog.txt node scripts/seed-demo.mjs
//
// The server must have `mail_log_file` set (the seed reads the emailed
// verification code from it). Re-running is a no-op once the user exists.
import { readFileSync } from 'node:fs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8124';
const MAIL_LOG = process.env.MAIL_LOG ?? 'deploy/api/app/maillog.txt';

// Local demo login (not a real account anywhere).
const DEMO_EMAIL = 'demo@spendtracker.test';
const DEMO_PASSWORD = 'demo-schedule-2026';

if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to seed ${BASE}: the demo seed only runs against a local server.`);
  process.exit(1);
}

const cookies = new Map();
let csrf = '';

async function call(method, path, body) {
  const headers = { Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const data = await res.json().catch(() => null);
  if (data?.csrf) csrf = data.csrf;
  return { status: res.status, data };
}

async function must(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
// `day` of the month `back` months before this one.
const monthsAgo = (back, day) => iso(new Date(now.getFullYear(), now.getMonth() - back, day));
// The most recent `day` of a month that isn't in the future.
const lastPast = (day) => (now.getDate() >= day ? monthsAgo(0, day) : monthsAgo(1, day));

await call('GET', '/auth/me');
const reg = await call('POST', '/auth/register', { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo' });
if (reg.status === 409) {
  console.log(`Demo user ${DEMO_EMAIL} already exists — nothing to do.`);
  process.exit(0);
}
if (reg.status !== 200) throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.data)}`);

const block = readFileSync(MAIL_LOG, 'utf8')
  .split('----')
  .filter((b) => b.includes(`TO: ${DEMO_EMAIL}`) && /verification code/i.test(b))
  .pop();
const code = block?.match(/code is:\s+(\d{6})/)?.[1];
if (!code) throw new Error(`No verification code for ${DEMO_EMAIL} in ${MAIL_LOG}`);
await must('POST', '/auth/verify', { code });
await must('POST', '/auth/currency', { currency: 'PHP' });

const account = (name, type, color, openingBalanceCents, dueDay = null) =>
  must('POST', '/accounts', { name, type, color, image: null, dueDay, dueDay2: null, openingBalanceCents });
const bank = await account('UnionBank 1100', 'debit', '#f97316', 500000);
await account('GCash', 'debit', '#38bdf8', 215000);
await account('Emergency Fund', 'debit', '#34d399', 1200000);
const sloan = await account('SLoan 2', 'loan', '#a78bfa', 2940000, 5);
await account('UnionBank 0225', 'loan', '#fb7185', 17959764, 25);
await account('SPayLater', 'credit', '#facc15', 834600, 5);

const cats = await must('GET', '/categories');
const cat = (name) => cats.find((c) => c.name === name).id;
const tx = (amountCents, type, category, date, note) =>
  must('POST', '/transactions', {
    amountCents, type, categoryId: cat(category), accountId: bank.id, date, time: null, note,
  });

// Last payday's salary is recorded; the one before it is left unlogged.
await tx(5400000, 'income', 'Salary', lastPast(8), 'Salary');
for (const [back, cents] of [[1, 331000], [2, 348000], [3, 312000]]) {
  await tx(cents, 'expense', 'Utilities', monthsAgo(back, 18), 'Meralco electricity');
}
await tx(45000, 'expense', 'Utilities', monthsAgo(1, 20), 'Maynilad water');
await tx(315000, 'expense', 'Groceries', monthsAgo(0, 3), 'Weekly groceries');
await tx(280000, 'expense', 'Groceries', monthsAgo(0, 10), 'Weekly groceries');

// Last month's installment, so the schedule can prefill the loan's amount.
await must('POST', '/transfers', {
  fromAccountId: bank.id, toAccountId: sloan.id, amountCents: 490000, feeCents: 0,
  date: lastPast(5), time: null, note: 'Payment to SLoan 2',
});

await must('POST', '/subscriptions', {
  name: 'Netflix', amountCents: 54900, accountId: bank.id, categoryId: cat('Subscriptions'),
  cycle: 'monthly', intervalDays: null, nextDate: monthsAgo(-1, 2), active: true,
});

console.log(`Seeded demo user ${DEMO_EMAIL} at ${BASE} (password: see DEMO_PASSWORD in this script).`);

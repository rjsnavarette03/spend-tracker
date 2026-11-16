# CLAUDE.md — SpendTracker

Orientation for an AI agent (or new engineer) working in this repo. Read this first.

## What this repo is

**SpendTracker** — a personal budget / spending / income tracker. It's a **multi-user web app**: a React + TypeScript SPA talking to a small **PHP 8 + MySQL** JSON API, with accounts (email/password + Google). It's built to run on shared hosting.

**Deployed live at https://budgettracker.rjsnavarette.com** (Hostinger shared hosting). See "Deployment" below.

Core conventions: **money is stored as integer cents everywhere**, dates are `YYYY-MM-DD` strings and months are `YYYY-MM` strings, and money is only formatted to decimals at the UI edge.

> This repo previously also contained an Electron desktop app at the root; it has been removed. The web app (formerly under `web/`) is now the whole repo.

---

## The app

React SPA (`src/`) talking to a small PHP JSON API (`server/`) under `/api`. No framework, no Composer. MySQL/MariaDB in production; SQLite supported for local dev. **The schema auto-creates on first request** — no manual import needed.

### Commands (run from repo root)
```bash
npm install
npm run dev        # Vite dev server on :5174, proxies /api → http://127.0.0.1:8124 (run a PHP server there)
npm run typecheck
npm run build      # typecheck → unit tests → vite build → dist/ (a failing test stops the build)
npm run assemble   # node scripts/build-deploy.mjs → assembles deploy/ (the uploadable site)
npm test           # unit tests (Vitest) for the Schedule's pure logic, src/schedule.test.ts — no server needed
                   #   (also src/reminders.golden.test.ts, which writes test/fixtures/reminders/*.json,
                   #   and src/assistantText.test.ts for the AI chat's reply formatting)
npm run test:php   # PHP reminder rules vs those golden files (php on PATH; locally C:\xampp\php\php.exe)
npm run test:api   # end-to-end API suite (needs a running server; see below)
```

### Local run + test
```bash
# 1. build the site
npm run build && npm run assemble
# 2. create deploy/api/app/config.php from config.sample.php (SQLite is easiest for local):
#    'db' => [ 'dsn' => 'sqlite:' . __DIR__ . '/data.sqlite' ]
#    (optionally) 'mail_log_file' => __DIR__ . '/maillog.txt'   # makes reset emails testable offline
# 3. serve it with PHP's built-in server:
php -S 127.0.0.1:8124 -t deploy deploy/router.php
# 4. run the tests against it:
API_BASE=http://127.0.0.1:8124 MAIL_LOG=./deploy/api/app/maillog.txt \
  REMINDERS_CRON=./deploy/api/app/cron/send-reminders.php PHP_BIN=C:/xampp/php/php.exe node test/api-test.mjs
# 5. (optional) the AI assistant section: the suite plays the AI provider itself.
#    Add to that site's config.php: 'ai' => ['api_key' => 'test', 'base_url' => 'http://127.0.0.1:8199/v1'],
#    then also pass AI_MOCK_PORT=8199. Never point a test run at a real key: it spends the shared daily quota.
```
To run the suite against MariaDB too, serve a second copy of `deploy/` (its own `config.php` with a mysql DSN, e.g. on :8125) — but note browser cookies are per HOST, not port: opening `localhost:8125` in the same browser replaces the `localhost:8124` session cookie (same `session_name`), signing you out there.

`test/api-test.mjs` is the source of truth for API behavior — a ~337-assertion suite covering auth (register/login/logout, session, CSRF, cross-origin rejection, throttling), **email verification (code + backup link + resend + the unverified-data gate)**, CRUD, report math, budgets, foreign-key behavior, cross-user isolation, change-password, the full forgot→reset flow, and the **payment schedule** (items per kind, 3-month bill estimate, mark-paid → transfer/transaction + link, link cascade, savings milestones), and the **reminder-email setting + unsubscribe link** (one-click POST, GET redirect, stale token after re-enabling) plus the **daily reminder job**, run for real through PHP's command line with `--now` across four mornings (before 7 AM, dry run, one email a day, a new stage re-emails the whole list, paid items drop out, opted-out users skipped, the new unsubscribe link after re-enabling). The job section needs `REMINDERS_CRON` (that site's `api/app/cron/send-reminders.php`) and `PHP_BIN`, and is skipped with a warning without them. Also **archiving settled accounts** (balance and subscription guards, paused schedule items, history kept, auto-restore on a new transfer/transaction, Restore, cross-user 404), and the **AI assistant** against a fake provider the suite runs on `AI_MOCK_PORT` (what the server sends it, each user's snapshot and tool searches holding only their own data, history capping, the tool round trip and its 3-round cap, retry after a malformed tool call, provider 429/500 mapped and refunded, 422s never sent or counted, the daily cap); without `AI_MOCK_PORT` only the session/CSRF/status checks run. It has been run green against **both SQLite and MariaDB** (the assistant section so far on SQLite only). It registers 19 users, just under the per-IP limit of 20 registrations/hour — a second full run within the hour hits 429s (clear `auth_throttle` in a local test DB, or wait). `MAIL_LOG` (paired with `mail_log_file` in config) is now **required** — the suite reads emailed verification codes/tokens (and reset tokens) from it, since registration now emails a verification code that every data-touching test must consume before its account unlocks.

### Key files
- `server/api/index.php` — the API front controller. Routing, origin/CSRF checks, dispatch. Uses `ob_start()`/`ob_clean()` so stray whitespace/BOM in `config.php` can't corrupt headers.
- `server/api/app/lib/` — `http.php` (session, CSRF, origin check, rate limiter, JSON), `db.php` (PDO + auto-migration), `auth.php` (register/login/google/logout/change-password/forgot/reset + **email verification: issue/verify-code/verify-link/resend, and `requireVerifiedUser`**), `repo.php` (all data access, user-scoped), `validate.php`, `mailer.php`, `reminders.php` (`Reminders::build` — a pure PHP port of `buildReminders` and everything it uses from `src/schedule.ts`, run on the API's own arrays, for the reminder emails), `reminder_email.php` (all reminder email text: `daily`, the `turnedOn` confirmation, unsubscribe links/headers, `SEND_HOUR` = 7, money formatted like the app — `NumberFormatter` when intl is loaded, a small symbol table otherwise).
- `server/api/app/lib/assistant.php` — the **AI assistant** behind the floating chat (`Assistant::status`, `Assistant::chat`). Calls any OpenAI-compatible Chat Completions API with curl (config `'ai'`: `api_key` (empty = off), `base_url` (default Groq), `model` (default `openai/gpt-oss-120b`), `provider_name`, `daily_limit` (20), `reasoning_effort` (`low`)). The model never touches the DB: each question sends a compact text snapshot (accounts + due days, 12 monthly totals, this/last month by category, budgets vs their period, active subscriptions, this month's transfers, `Reminders::build`'s due/overdue/payday list, category names) built from the same `Repo` reads the app uses, plus one read-only tool, `search_transactions` (from/to incl. `YYYY-MM`, text, category, account, type → match count, totals over all matches, ≤40 rows), which the server runs through `Repo::listTransactions`, scoped to the user. Up to 3 tool rounds, then `tool_choice: none`; a 400 for a malformed tool call is retried without tools. History comes from the browser (≤20 accepted, last 10 forwarded, questions ≤500 chars) and nothing is stored. Per-user daily cap in `auth_throttle` (`assistant:<uid>`, 24 h window), counted before the call and refunded on any failure (`Http::throttleUsage` / `throttleRefund`). Provider 429 → our 503 with the provider's Retry-After; other provider failures → 502 (bad key / unknown model are logged). Groq's free tier is shared by the WHOLE site (for gpt-oss-120b roughly 30 requests/min, 1K requests and 200K tokens a day, 8K tokens/min — a question with a tool call is ~5K tokens), so busy 503s are expected under load.
- `server/api/app/cron/send-reminders.php` — the **hourly reminder job** (CLI only; inside the web-blocked `app/`). For each verified user with reminders on, once it's 7 AM+ in their `timezone` and their `reminders_run_on` isn't today: claims the day (conditional UPDATE, so overlapping runs can't double-send), charges due subscriptions (`Repo::processDueSubscriptions` — a stale charge date would read overdue), builds the reminders, and emails the whole list only if some key isn't in `reminder_sends` yet; then records the new keys. A failed send hands the day back (retried next hour). Prunes `reminder_sends` after 90 days. Refuses to send unless `mail_from` (or `mail_log_file`) is set — from cron there's no host, so mail would go out as noreply@localhost. Flags: `--dry-run` (print the email; send, charge, record nothing), `--user=ID`, `--now=TIME`. `assemble` copies `cron/`.
- `server/api/app/config.sample.php` — copy to `config.php` (gitignored) and fill in DB creds + optional `google_client_id` + optional `mail_from`.
- `server/schema.mysql.sql` / `schema.sqlite.sql` — schema per dialect.
- `server/public/.htaccess` — SPA fallback + `/api` rewrite + security headers (CSP etc.). `server/api/app/.htaccess` — denies web access to `app/` (protects `config.php`).
- `server/router.php` — local `php -S` router only (harmless in production).
- `scripts/build-deploy.mjs` — the `assemble` step. Note it empties ALL of `deploy/` first, including a local `api/app/config.php` / `data.sqlite` / `maillog.txt` — to refresh only the frontend locally, `npm run build` then copy `dist/` over `deploy/` (after removing `deploy/assets`).
- `scripts/seed-demo.mjs` — seeds a local demo user (login in the script) with made-up accounts/history for trying the Schedule page; refuses non-localhost `API_BASE`.
- `src/api.ts` — typed fetch client; holds the CSRF token; dispatches `AUTH_EXPIRED_EVENT` on 401.
- `src/components/AssistantWidget.tsx` — the floating **"Ask about your money"** chat, mounted once in the `App.tsx` layout so it is on every signed-in page: a bubble bottom right (above the mobile tab bar; z-index 40, under modals 50 and toasts 60) that opens a 384px chat window (full screen at ≤860px, where the bubble hides and the header has the close button). Renders nothing unless `GET /assistant` says `enabled`; while shown it puts `has-assistant` on `<body>`, which adds bottom padding to `.main` and lifts the toasts above the bubble. Greeting + suggestion chips, then the chat log; Escape (unless a modal is open) and the X close it and return focus to the bubble; a red dot marks an answer that arrived while closed. The conversation is kept in a module-level `Map` keyed by user id (survives page changes, not a reload) and the last 10 messages go with each question. A failed question goes back into the input box. Footer names the provider, shows questions left today and links `/privacy`. Replies are plain text turned into paragraphs/lists by `src/assistantText.ts` (`replyBlocks`, which drops Markdown marks rather than rendering HTML).
- `src/accounts.ts` — `isArchived(a)` = `archivedAt` set AND balance 0 (an archived account that somehow carries a balance again counts as active, so money is never hidden). Archived accounts stay in the shared `accounts` list (history, lookups and the account's own page need them) but: the Accounts page moves them from the type sections to a collapsed `<details>` "Archived (N)" panel; every picker for NEW entries skips them (Transaction/Transfer/Pay/Borrow/MarkPaid/LogReceived/AccountEdit modals, Schedule item + payday forms, Subscriptions), while edit forms keep the account an entry already uses (TransactionModal's "Other" group, TransferModal's optionsFor, `|| a.id === initial?.…`). `AccountDetail` shows Archive only at balance 0 (confirm names the Schedule plans that will pause; then back to /accounts), Restore + a banner once archived, and the Delete confirm suggests Archive for settled accounts with history.
- `src/AppRoot.tsx` — client-side routing root (**react-router-dom**, `BrowserRouter` in `main.tsx`). Loads the session (`/auth/me`), guards routes, and maps URLs → pages. `/` = **public marketing Landing** (`src/pages/Landing.tsx`, rendered for everyone incl. while the session loads; CTA switches to "Go to dashboard" when signed in) — the app itself lives at `/dashboard`. Signed-in app pages: `/dashboard` `/transactions` `/accounts` `/accounts/:id` `/schedule` `/subscriptions` `/budgets` `/categories` `/settings` (currency + password behind one Save, reminder emails on/off, plus delete-account danger zone; reached via the gear icon — it is NOT in the primary nav/tab bar). Signed-out: `/login` `/register` `/forgot-password` (a protected path while anon redirects to `/login?next=…`, honored after login; `next` defaults to `/dashboard`, never `/`). Post-login → `/dashboard`; logout → `/` (landing). **A signed-in but email-unverified user (`user.emailVerified === false`) is intercepted before the app routes and shown `VerifyEmail` (code entry) regardless of path — this is the client half of the verification gate; the server half is `requireVerifiedUser`.** `/privacy` `/terms` are public standalone pages (short-circuited before the auth branch, like the landing). The emailed `/?reset=<token>`, `/?verify=<token>` and `/?unsubscribe=<token>` links (see `auth.php`, `reminder_email.php`) short-circuit to the reset / email-verify / unsubscribe screens (unsubscribe works signed in or out; a malformed token — the API GET redirect passes one on as empty — shows a broken-link message). Deep links work via the `.htaccess`/`router.php` SPA fallback.
- `src/App.tsx` — the signed-in **layout shell**: sidebar `NavLink`s + `<Outlet context>`. Shared `month`/`categories`/`accounts` state lives here (survives page navigation) and pages read it via `useAppContext()`; `onDataChanged` also bumps `dataVersion`, which the Schedule page (it holds its own data) reloads on. **Reminders** (`src/components/Reminders.tsx`, logic `buildReminders` in `src/schedule.ts`): a bell next to theme/settings (sidebar foot + mobile top bar) whose badge counts reminders not yet seen; its panel lists every unpaid due date from 3 days before (`REMIND_DAYS`) — then due today, then overdue — and each payday on its expected date until its salary is logged (up to 3 days after), with Mark as paid / Log received (`MarkPaidModal`, `LogReceivedModal`) and forecast shortfalls tagged. Same span/filters as the planner (card-charged subscriptions skipped, lapsed allowances never remind). Paid = gone, however it was paid. "Seen" is per browser in localStorage (`spendtracker-reminders-seen:<userId>`, keys `stage|itemId|date`, so a seen reminder returns at its next stage); no server state. **Responsive chrome**: desktop uses the sidebar; ≤860px swaps to native-app chrome — a sticky `.mobile-topbar` (logo + theme/settings/logout) and a fixed bottom `.tabbar` (6 tabs, icon+label — Subscriptions shortens to "Subs" — safe-area padded; Categories is sidebar-only via `tab: false` in `NAV` and is reached on mobile from a Settings link). On mobile the core tables restack into card lists via CSS grid (`tx-cards`, `recent-table`, `budgets-table`, `detail-transfers`, `transfers-cards` classes — the nth-child mappings break if a table's column order changes); other wide tables scroll inside their `.panel`, never the page.
- `src/auth/` — `Login` (one component; signin/register/forgot mode is driven by the route), `ResetPassword`, and `VerifyEmail` (`mode="code"` for the signed-in-unverified gate, `mode="link"` to redeem a `?verify=` backup token), and `Unsubscribe` (the reminder-email link: asks first — scanners open links — then signed-in users land on Settings once the session is reloaded, since the layout keeps the user it mounted with). `src/pages/Settings.tsx` (currency + change/set password + **Email reminders** — an Off/On switch that saves immediately, sending this device's time zone; offers to move the 7 AM to this device's zone when they differ, and after turning on says a confirmation was emailed + check spam — + delete account; replaced the old AccountModal), `src/pages/Schedule.tsx` (payment schedule, five views in `?view=` — Planner, Forecast, Calendar, Progress, Setup. **Progress** = debt payoff (`buildDebtPlan` + `src/components/DebtPayoff.tsx`): walks each owed loan/card balance down its schedule (paid due dates skipped, partial ones pay their remainder, the last payment capped at what's left — no interest modelled, extra payments shorten the term) → per-debt payoff date, debt-free date (latest payoff; unscheduled debts are listed and excluded), total-owed chart, and a what-if (extra ₱X this month on one debt). Balances are live, so a real extra payment moves the dates by itself. Below it, **Savings goals** (`buildGoals` + `src/components/SavingsGoals.tsx`): saved = the live balance of the account the goal pays into (shared accounts count toward each goal, with a note), a bar with milestone ticks, chips (✓ reached / next / later with month estimates), and the next checkpoint's estimated date — walking the goal's unpaid due dates (overdue → today) until the balance reaches each milestone and the goal; paused goals show their balance but no dates. Milestones are `schedule_items.goal_milestones` (savings only, CSV of ascending cents, ≤ 8, none above the goal; with no goal set, the largest milestone becomes the goal). Charts share `src/components/StepChart.tsx` (time-proportional step line, crosshair tooltip, container-sized). **Payday planner** (default) = one card per payday (`buildPlanner` in `src/schedule.ts`: current payday, next N, earlier paydays still funding a pinned upcoming bill — shown "closed", and recent unlogged ones) listing what it funds, scheduled vs left, red when over-allocated, with "Log received"; each line has a status from `dueStatuses` — paid / partial ("₱X left") / overdue / due today — and a Mark-as-paid button (`src/components/MarkPaidModal.tsx` → `POST /schedule/pay`, any amount = partial/extra; an extra payment raises the card's committed total). Payments made OUTSIDE the Schedule also count: a transfer into a loan/card/savings item's account, or an expense in a bill's category whose note contains its keyword, settles that item's EARLIEST unpaid due date within 45 days late / 31 days early (each payment counts once; bills with a keyword claim theirs before catch-all bills in the same category) (never before the item's startDate; allowances only count Schedule payments). Past-due unpaid dates whose payday card isn't shown appear in an "Overdue" card on top. A past allowance week with nothing marked is `lapsed` ("Past"), never overdue — its spending is already in the balance. **Forecast** (`?view=forecast`, `buildForecast`) = 60-day day-by-day cash projection: starts from today's debit balances EXCEPT accounts a savings goal pays into, adds unlogged paydays on their expected date, subtracts each unpaid remainder on its due date (overdue → today; items paid from a card or a set-aside account, and card-charged subscriptions, are skipped), income first within a day; an outflow the running balance can't cover is a shortfall (`amount − max(0, balance before)`), listed as "Short ₱X on <date> for <item>", dotted red on the chart (`src/components/ForecastChart.tsx`, sized to its container so 11px labels stay 11px), and tagged on the matching planner line. **Calendar** (`?view=calendar`, `buildCalendar` + `src/components/ScheduleCalendar.tsx`) = Sunday-first month grid: paydays on their expected date, due dates as chips whose state is a symbol AND a color — ✓ paid, plain upcoming, ⚠ at risk (forecast shortfall), ! overdue, ↻ auto-charged; phones show colored dots and the selected day's details (shared `src/components/PlanLine.tsx` — `PlanLine` for a due date, `PaydayLine` for a payday — with Mark as paid / Log received) below the grid. Statuses use the planner's occurrence span so a date reads the same in every view; **Setup** = monthly summary, scheduled items grouped by kind with unscheduled owing loans/cards suggested, and paydays; add/edit form in `src/components/ScheduleItemModal.tsx`; pure date/status math lives in `src/schedule.ts` — occurrences are keyed by their NOMINAL date (paydays' `date` is after the weekend shift); loans/cards read due days from their account; subscriptions always appear via `withSubscriptions` stand-ins (negative ids) and only get a real row when their funding payday is pinned; card-charged subscriptions are excluded from cash totals (`chargedToCard`)), `src/pages/`, `shared/types.ts`.

### API endpoints (all under `/api`)
```
GET  /health                      → { ok, php, db }
GET  /auth/me                     → { user|null, csrf, googleClientId }
POST /auth/register               { email, password, name, currency? }  (pre-auth;
                                    currency = region-detected default hint from the
                                    client (format.ts detectDefaultCurrency, tz-first);
                                    sanitized server-side, junk → USD, never a 4xx)
POST /auth/login                  { email, password }              (pre-auth)
POST /auth/google                 { credential, currency? }        (pre-auth; hint
                                    applies only when first sign-in creates the user)
POST /auth/forgot                 { email } → always { ok:true }   (pre-auth)
POST /auth/reset                  { token, password }              (pre-auth)
POST /auth/verify                 { code }                         (signed-in, unverified)
POST /auth/verify-link            { token } → signs in             (pre-auth)
POST /auth/resend-verification                                     (signed-in, unverified)
POST /auth/logout
POST /auth/currency               { currency } → { ok, currency }  (auth; ISO-4217, 422 on junk)
POST /auth/reminders              { enabled, timezone? } → { ok, reminderEmails,
                                    reminderTimezone }  (verified; reminder emails
                                    opt-in. Turning on needs an IANA zone
                                    (DateTimeZone ALL_WITH_BC, 422 on junk), and
                                    when they were off: new unsubscribe token +
                                    a "Reminder emails are on" confirmation email
                                    (max 5/hour, extra toggles skip the email).
                                    /auth/me's user carries both fields.)
POST /reminders/unsubscribe       ?token= or { token }  → { ok }  (TOKEN-ONLY: no
                                    session, CSRF or origin check — mail
                                    providers' RFC 8058 one-click POSTs a form
                                    body from their servers. Only turns reminders
                                    off; repeat clicks still 200; 400 bad/stale.
                                    GET → 302 /?unsubscribe=<token>, never
                                    unsubscribes — link scanners only GET.)
POST /auth/change-password        { currentPassword, newPassword } (auth)
POST /auth/delete-account         { currentPassword } (auth even if unverified;
                                    password required only when the account has
                                    one; users row cascades ALL data; session dies)
# register returns an unverified user + emails a 6-digit code and a /?verify= link;
# all endpoints below require a signed-in AND email-verified user (requireVerifiedUser).
GET  /categories                        POST /categories            { name, type, color }
PUT  /categories/:id  { name, color }   DELETE /categories/:id
GET  /accounts                          POST /accounts  PUT/DELETE /accounts/:id
     (AccountInput. Optional card/loan details: creditLimitCents + statementDay
      (1–31) on credit cards only, interestRateBp (yearly rate in basis points,
      3600 = 36%; 0 is stored as null) on credit and loan accounts — 422 on the
      wrong type. On PUT a key left out of the body keeps the stored value, so
      an older client can't wipe them; null clears.)
POST /accounts/:id/archive → { archivedAt, pausedItems }   POST /accounts/:id/restore
     (archive = hide a SETTLED account — balance exactly 0, else 422; also 422
      while an active subscription charges it — from lists/pickers, history
      untouched (delete NULLs every link instead). Pauses active schedule_items
      whose account_id is it (pay-from references untouched) and returns their
      names; idempotent. GET /accounts still returns archived accounts with
      archivedAt set. Any NEW transaction/transfer on it — Schedule payments and
      subscription charges included (Repo::restoreOnActivity) — clears
      archivedAt; edits of old rows do not. Restore leaves paused items paused.)
GET  /transactions?month|from&to|type|categoryId|accountId|search   (all filters optional)
POST /transactions   (TxInput)          PUT/DELETE /transactions/:id
GET  /transfers?month                   POST /transfers  (TransferInput)
PUT  /transfers/:id                      DELETE /transfers/:id
     (money moved between accounts, optional fee; fee + amount leave the source,
      only amount reaches the target; deleting an account NULLs its side.
      toAccountId may be null ONLY when the source is a loan — an undeposited
      "Borrow again" that grows the debt but lands nowhere)
GET  /budgets                           PUT /budgets { categoryId, cadence, amountCents }  (0 deletes)
     (budgets are recurring per-category rules; cadence = week|month|year)
GET  /subscriptions                     POST /subscriptions  (SubscriptionInput)
PUT  /subscriptions/:id                 DELETE /subscriptions/:id
     (recurring auto-charges: cycle = monthly [bill_day derives from nextDate,
      re-lands on that day, 29–31 clamp in short months] | yearly [same month +
      bill_day every year, Feb 29 clamps in non-leap years] | interval [every
      intervalDays]. Repo::processDueSubscriptions runs before EVERY data
      request: while next_date <= today it inserts an expense tx dated the DUE
      date on the linked account and advances next_date — atomic claim via
      conditional UPDATE so concurrent requests can't double-charge; catch-up
      capped at 60 cycles/request. Paused (active=0) or account-deleted
      (account_id NULL via SET NULL) subs never charge; resuming rolls
      next_date forward WITHOUT back-charging. Loan accounts rejected.)
GET  /schedule → { items, payments, activity }   (payment schedule / Schedule page)
POST /schedule/items  (ScheduleItemInput)  PUT/DELETE /schedule/items/:id
POST /schedule/pay    (SchedulePayInput) → { payment, transfer|null, transaction|null }
     (planning layer over the ledger. items: kind = income (a payday) | loan |
      card | bill | allowance | savings | subscription. Loans/cards take due
      days from their account; bills/savings/paydays have dueDay; allowances
      weekDay. 'subscription' rows only hold the funding payday — subs stay
      auto-charged and can't be paid here. avg3 bills return estimateCents =
      last 3 complete months in the category (+ optional note keyword) ÷ 3.
      Bills keep matchKeyword in BOTH modes — the client also uses it to
      decide which category expenses count as paying that bill.
      pay = createTransfer (loan/card/savings) or createTransaction
      (income/bill/allowance) + a schedule_payments link, in one DB
      transaction; any amount (partial/extra). Links read amount/date from
      the ledger row and CASCADE away when it's deleted; deleting an item
      never touches the ledger. kind is immutable on update.)
GET  /assistant → { enabled, provider, dailyLimit, remaining }   (Dashboard AI chat)
POST /assistant/chat  { messages: [{ role: user|assistant, content }] } → { reply, remaining }
     (last message must be the question; 422 on bad input, 429 once the user's
      daily questions are used up, 503 when not configured or the provider is
      rate-limited, 502 when the provider fails. See lib/assistant.php.)
GET  /reports/summary?month             GET /reports/trend?endMonth&count
GET  /reports/breakdown?month&type      GET /reports/years → [YYYY,…] (years with tx)
GET  /reports/networth?months=12 → [{ month, assetsCents, liabilitiesCents, netCents }]
     (net worth at each month end, oldest first, 1–60 months; the Accounts page's
      "Net worth over time" chart. Balance at a month end = opening + everything
      dated up to then; an account counts from the month it was added or of its
      first dated entry, months before the first account are left out, and the
      newest point takes every entry so it always equals the Net Worth card.)
```

### Security model
- Every query in `repo.php` is scoped to the session `user_id`; ownership of referenced categories is verified on write (no IDOR). A transaction/budget cannot reference another user's category, and a transaction's category must match its `type`. Transactions can never link a **loan** account (422; loans are managed purely via transfers — Pay / Borrow again).
- **Authenticated** mutations require an `X-CSRF-Token` header (token from `/auth/me`, rotates on login/change-password). **Pre-auth** mutations (login/register/google/forgot/reset/**verify-link**) carry no token, so they use a strict same-origin check via the unforgeable `Sec-Fetch-Site` header (falling back to `Origin`). `verify`/`resend-verification` are authenticated (signed-in-but-unverified) and keep the CSRF check. The one exception to both checks is `/reminders/unsubscribe` (`$tokenOnly` in `index.php`), authorized by its link token alone.
- **Reminder emails** (opt-in, `users.reminder_emails` DEFAULT 0): `users.reminder_token` (32 random bytes, hex) is stored as-is, NOT hashed, because it goes into every reminder email's unsubscribe link and can do nothing but turn reminders off. It's replaced whenever reminders are turned on from off, so links in older emails stop working. `reminder_sends` records which reminder keys were emailed (once per stage); `users.reminders_run_on` is the user's local date of the last daily check.
- **Email verification**: email/password `register()` inserts `users.email_verified = 0` and emails a 6-digit code (hashed, stored) + a one-time backup link token (hashed) in the `email_verifications` table (one active row per user, wrong-code `attempts` capped, 30-min expiry). `requireVerifiedUser` gates every data endpoint (403 until verified); `/auth/*` stays reachable so an unverified user can verify/resend/logout. Google sign-in and completing a password reset both mark the email verified. The `users.email_verified` column DEFAULTs to 1 so pre-existing accounts are never locked out.
- Sessions: HttpOnly, `SameSite=Lax`, `Secure` under HTTPS, `session_regenerate_id` on login/password-change/verify-link.
- Rate limiting (`auth_throttle` table): per-IP and per-account on login/register/google/forgot/reset/verify/resend-verification; per-IP on reminder unsubscribe; per-user on the reminders-on confirmation email; per-user daily questions to the AI assistant.
- **AI assistant**: the API key lives only in the server's `config.php`. The model gets text, never DB access: a snapshot and a read-only tool, both built from `Repo` calls scoped to the session user (the API suite checks neither leaks another user's data). The system prompt tells it to treat names/notes as data, not instructions; a prompt-injected note could only mislead that same user's own answers. Users' questions and data summaries go to the provider, which the privacy policy names (Groq) — update `src/pages/Legal.tsx` if the provider changes.
- Passwords hashed with `password_hash` (`PASSWORD_DEFAULT`). Google ID tokens verified server-side (audience/issuer/expiry/`email_verified`).
- Reset tokens: 32 random bytes, stored only as SHA-256 hash, 1-hour expiry, single-use. Verification codes (6-digit) and backup-link tokens (32 bytes): SHA-256-hashed, 30-min expiry, single-use, code burned after 6 wrong guesses.

### Gotchas
- **`config.php` is gitignored and required** — the API returns 500 ("Server not configured") without it. Always `cp config.sample.php config.php` per environment. `assemble` never creates it (so DB creds can't be committed) and redeploys must never overwrite it.
- **DB auto-migration**: `DB::ensureSchema` probes the newest table (`reminder_sends`); if missing it re-runs the full `CREATE ... IF NOT EXISTS` schema (idempotent, preserves data — this is how a new table lands on an existing DB). **When you add a table: add it to both schema files AND update the probe table name in `db.php`.** The schema files must be saved WITHOUT a UTF-8 BOM (PowerShell `Set-Content -Encoding utf8` adds one; SQLite tolerates it but MySQL rejects the first statement) — the loader now strips a leading BOM defensively, but don't rely on it. Schema *changes* to existing tables can't ride the replay (CREATE IF NOT EXISTS won't alter) — add an idempotent, self-healing migration step instead (see `migrateBudgetsToCadence`: MySQL does in-place guarded ALTERs keyed off the final index; SQLite rebuilds the table since it can't drop a column inside a UNIQUE constraint). New *columns* on existing tables get a guarded `columnExists`-then-`ALTER` step (e.g. `users.email_verified`, added `DEFAULT 1` so pre-existing rows stay verified; `schedule_items.goal_milestones`, nullable; the four `users.reminder_*`/`timezone` columns, step 11, `reminder_emails` DEFAULT 0 so nobody is opted in; `accounts.archived_at`, step 12, nullable DATETIME — not TIMESTAMP, which MySQL can auto-fill).
- **Dialect branching**: `Repo::upsertBudget` uses SQLite `ON CONFLICT` vs MySQL `ON DUPLICATE KEY UPDATE` (`DB::driver()`). Keep the `UNIQUE(category_id)` constraint on `budgets` in both schemas or upsert breaks.
- Reset emails go through PHP `mail()`; set `mail_log_file` in config to write them to a file instead (local/test). Deliverability on shared hosting is imperfect — for production, `mail_from` should be a real mailbox on the domain.
- Account delete → its transactions' `account_id` and transfers' side `SET NULL` (history shows "Deleted account") — archive settled accounts instead. Category delete → transactions `SET NULL` (become "Uncategorized"), budgets `CASCADE`. Users cascade-delete everything.

---

## Deployment (→ Hostinger)

Live at **https://budgettracker.rjsnavarette.com** on **Hostinger shared hosting (hPanel)**, PHP 8.3 (web) + MySQL/MariaDB. Deploys over **SSH with key auth**.

**Process** (from repo root): `npm run build && npm run assemble` produces `deploy/` — the entire uploadable site. Tar it (excluding `api/app/config.php`, `*.sqlite`, `maillog.txt`), scp to the server, extract into the subdomain's `public_html`, remove the stale hashed files in `assets/` first, and `rm router.php`. **Never overwrite the server's `api/app/config.php`** (holds DB creds, chmod 600, not web-accessible). Verify with `GET /api/health` → `{"ok":true,...,"db":true}`. **Reminder emails** also need, once: `mail_from` set in the server's `config.php` to a real mailbox on the domain, and an hourly cron job in hPanel → Advanced → Cron Jobs running `/opt/alt/php83/usr/bin/php <doc root>/api/app/cron/send-reminders.php` (SSH has no `crontab`; the CLI's default `php` is 8.2). The **AI assistant** needs only `'ai' => ['api_key' => …]` in the server's `config.php` (outbound HTTPS from PHP's curl, which Google sign-in already relies on). Full step-by-step (including the hPanel/DB/SSL/Google-OAuth setup) is in **`DEPLOY.md`**.

**Secrets are intentionally NOT in this repo.** To deploy/redeploy you need, from the repo owner:
- SSH host / port / username (Hostinger hPanel → Advanced → SSH Access)
- the subdomain document-root path
- MySQL database name / user / password (hPanel → Databases)

The SSH **private key** lives on the owner's machine at `~/.ssh/hostinger_spendtracker` (its public key is already registered in hPanel); the key itself is never committed. If you are an AI agent with project memory for this repo, these specifics may be recorded there — otherwise ask the owner.

---

## What a fresh clone is missing

Because of `.gitignore`, a fresh checkout does **not** include: `node_modules/` (run `npm install`), `dist/` + `deploy/` (run `npm run build && npm run assemble`), any `*.sqlite`, and `server/api/app/config.php` (create from `config.sample.php`). None of these belong in git.

## Conventions to preserve

- Integer cents for money, end to end; format only at the UI.
- Keep `shared/types.ts` as the contract source of truth.
- Match existing code style (dark theme CSS variables in `styles.css`; no CSS framework). All text-entry inputs are styled by one broad selector — don't reintroduce per-type input styling.
- When changing API behavior, update `test/api-test.mjs` and keep it green on both SQLite and MySQL.
- When changing `src/schedule.ts` (planner, forecast, calendar, debt payoff, goals, reminders), update `src/schedule.test.ts` and keep `npm test` green. Tests use a fixed TODAY (2026-10-28) and small fixture builders (`item`, `account`, `paid`, `transferIn`, `tx`).
- **Reminders exist twice** — `buildReminders` (TS, the bell) and `Reminders::build` (PHP, the emails) — and must agree. `src/reminders.golden.test.ts` holds hand-checked cases (`expectKeys`) and saves each one's inputs + full TS output to `test/fixtures/reminders/<case>.json`; `npm run test:php` runs the PHP on the same files. A change to reminders, or to anything they use (occurrences, statuses, payday matching, subscription stand-ins), fails the golden test: if intended, `npx vitest run -u` rewrites the files, then make the PHP match until `npm run test:php` passes. Within a stage and date, names sort with `Collator` when intl is loaded, else case-insensitively, so keep case names plain ASCII.

## Still optional / not done
- **AI assistant** is built but off until a key is set: create a free Groq API key (console.groq.com/keys) and put it in the server's `config.php` as `'ai' => ['api_key' => '…']`. Without it the chat bubble stays hidden.
- **Google Sign-In** is wired but off by default: set `google_client_id` (Web OAuth client, JS origin = the https subdomain) in the server's `config.php` to enable the button. Email/password works without it.
- Verify production email deliverability; if reset emails land in spam, use a real domain mailbox as `mail_from`.

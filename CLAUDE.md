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
npm run build      # typecheck → vite build → dist/
npm run assemble   # node scripts/build-deploy.mjs → assembles deploy/ (the uploadable site)
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
API_BASE=http://127.0.0.1:8124 MAIL_LOG=./deploy/api/app/maillog.txt node test/api-test.mjs
```
`test/api-test.mjs` is the source of truth for API behavior — a ~185-assertion suite covering auth (register/login/logout, session, CSRF, cross-origin rejection, throttling), **email verification (code + backup link + resend + the unverified-data gate)**, CRUD, report math, budgets, foreign-key behavior, cross-user isolation, change-password, and the full forgot→reset flow. It has been run green against **both SQLite and MariaDB**. `MAIL_LOG` (paired with `mail_log_file` in config) is now **required** — the suite reads emailed verification codes/tokens (and reset tokens) from it, since registration now emails a verification code that every data-touching test must consume before its account unlocks.

### Key files
- `server/api/index.php` — the API front controller. Routing, origin/CSRF checks, dispatch. Uses `ob_start()`/`ob_clean()` so stray whitespace/BOM in `config.php` can't corrupt headers.
- `server/api/app/lib/` — `http.php` (session, CSRF, origin check, rate limiter, JSON), `db.php` (PDO + auto-migration), `auth.php` (register/login/google/logout/change-password/forgot/reset + **email verification: issue/verify-code/verify-link/resend, and `requireVerifiedUser`**), `repo.php` (all data access, user-scoped), `validate.php`, `mailer.php`.
- `server/api/app/config.sample.php` — copy to `config.php` (gitignored) and fill in DB creds + optional `google_client_id` + optional `mail_from`.
- `server/schema.mysql.sql` / `schema.sqlite.sql` — schema per dialect.
- `server/public/.htaccess` — SPA fallback + `/api` rewrite + security headers (CSP etc.). `server/api/app/.htaccess` — denies web access to `app/` (protects `config.php`).
- `server/router.php` — local `php -S` router only (harmless in production).
- `scripts/build-deploy.mjs` — the `assemble` step.
- `src/api.ts` — typed fetch client; holds the CSRF token; dispatches `AUTH_EXPIRED_EVENT` on 401.
- `src/AppRoot.tsx` — client-side routing root (**react-router-dom**, `BrowserRouter` in `main.tsx`). Loads the session (`/auth/me`), guards routes, and maps URLs → pages. `/` = **public marketing Landing** (`src/pages/Landing.tsx`, rendered for everyone incl. while the session loads; CTA switches to "Go to dashboard" when signed in) — the app itself lives at `/dashboard`. Signed-in app pages: `/dashboard` `/transactions` `/accounts` `/accounts/:id` `/subscriptions` `/budgets` `/categories` `/settings` (currency + password behind one Save, plus delete-account danger zone; reached via the gear icon — it is NOT in the primary nav/tab bar). Signed-out: `/login` `/register` `/forgot-password` (a protected path while anon redirects to `/login?next=…`, honored after login; `next` defaults to `/dashboard`, never `/`). Post-login → `/dashboard`; logout → `/` (landing). **A signed-in but email-unverified user (`user.emailVerified === false`) is intercepted before the app routes and shown `VerifyEmail` (code entry) regardless of path — this is the client half of the verification gate; the server half is `requireVerifiedUser`.** `/privacy` `/terms` are public standalone pages (short-circuited before the auth branch, like the landing). The emailed `/?reset=<token>` and `/?verify=<token>` links (see `auth.php`) short-circuit to the reset / email-verify screens. Deep links work via the `.htaccess`/`router.php` SPA fallback.
- `src/App.tsx` — the signed-in **layout shell**: sidebar `NavLink`s + `<Outlet context>`. Shared `month`/`categories`/`accounts` state lives here (survives page navigation) and pages read it via `useAppContext()`. **Responsive chrome**: desktop uses the sidebar; ≤860px swaps to native-app chrome — a sticky `.mobile-topbar` (logo + theme/settings/logout) and a fixed bottom `.tabbar` (6 tabs, icon+label — Subscriptions shortens to "Subs" — safe-area padded). On mobile the core tables restack into card lists via CSS grid (`tx-cards`, `recent-table`, `budgets-table`, `detail-transfers`, `transfers-cards` classes — the nth-child mappings break if a table's column order changes); other wide tables scroll inside their `.panel`, never the page.
- `src/auth/` — `Login` (one component; signin/register/forgot mode is driven by the route), `ResetPassword`, and `VerifyEmail` (`mode="code"` for the signed-in-unverified gate, `mode="link"` to redeem a `?verify=` backup token). `src/pages/Settings.tsx` (currency + change/set password + delete account; replaced the old AccountModal), `src/pages/`, `shared/types.ts`.

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
POST /auth/change-password        { currentPassword, newPassword } (auth)
POST /auth/delete-account         { currentPassword } (auth even if unverified;
                                    password required only when the account has
                                    one; users row cascades ALL data; session dies)
# register returns an unverified user + emails a 6-digit code and a /?verify= link;
# all endpoints below require a signed-in AND email-verified user (requireVerifiedUser).
GET  /categories                        POST /categories            { name, type, color }
PUT  /categories/:id  { name, color }   DELETE /categories/:id
GET  /transactions?month&type&categoryId&search
POST /transactions   (TxInput)          PUT/DELETE /transactions/:id
GET  /budgets                           PUT /budgets { categoryId, cadence, amountCents }  (0 deletes)
     (budgets are recurring per-category rules; cadence = week|month|year)
GET  /subscriptions                     POST /subscriptions  (SubscriptionInput)
PUT  /subscriptions/:id                 DELETE /subscriptions/:id
     (recurring auto-charges: cycle = monthly [bill_day derives from nextDate,
      re-lands on that day, 29–31 clamp in short months] | interval [every
      intervalDays]. Repo::processDueSubscriptions runs before EVERY data
      request: while next_date <= today it inserts an expense tx dated the DUE
      date on the linked account and advances next_date — atomic claim via
      conditional UPDATE so concurrent requests can't double-charge; catch-up
      capped at 60 cycles/request. Paused (active=0) or account-deleted
      (account_id NULL via SET NULL) subs never charge; resuming rolls
      next_date forward WITHOUT back-charging. Loan accounts rejected.)
GET  /reports/summary?month             GET /reports/trend?endMonth&count
GET  /reports/breakdown?month&type      GET /reports/years → [YYYY,…] (years with tx)
```

### Security model
- Every query in `repo.php` is scoped to the session `user_id`; ownership of referenced categories is verified on write (no IDOR). A transaction/budget cannot reference another user's category, and a transaction's category must match its `type`.
- **Authenticated** mutations require an `X-CSRF-Token` header (token from `/auth/me`, rotates on login/change-password). **Pre-auth** mutations (login/register/google/forgot/reset/**verify-link**) carry no token, so they use a strict same-origin check via the unforgeable `Sec-Fetch-Site` header (falling back to `Origin`). `verify`/`resend-verification` are authenticated (signed-in-but-unverified) and keep the CSRF check.
- **Email verification**: email/password `register()` inserts `users.email_verified = 0` and emails a 6-digit code (hashed, stored) + a one-time backup link token (hashed) in the `email_verifications` table (one active row per user, wrong-code `attempts` capped, 30-min expiry). `requireVerifiedUser` gates every data endpoint (403 until verified); `/auth/*` stays reachable so an unverified user can verify/resend/logout. Google sign-in and completing a password reset both mark the email verified. The `users.email_verified` column DEFAULTs to 1 so pre-existing accounts are never locked out.
- Sessions: HttpOnly, `SameSite=Lax`, `Secure` under HTTPS, `session_regenerate_id` on login/password-change/verify-link.
- Rate limiting (`auth_throttle` table): per-IP and per-account on login/register/google/forgot/reset/verify/resend-verification.
- Passwords hashed with `password_hash` (`PASSWORD_DEFAULT`). Google ID tokens verified server-side (audience/issuer/expiry/`email_verified`).
- Reset tokens: 32 random bytes, stored only as SHA-256 hash, 1-hour expiry, single-use. Verification codes (6-digit) and backup-link tokens (32 bytes): SHA-256-hashed, 30-min expiry, single-use, code burned after 6 wrong guesses.

### Gotchas
- **`config.php` is gitignored and required** — the API returns 500 ("Server not configured") without it. Always `cp config.sample.php config.php` per environment. `assemble` never creates it (so DB creds can't be committed) and redeploys must never overwrite it.
- **DB auto-migration**: `DB::ensureSchema` probes the newest table (`subscriptions`); if missing it re-runs the full `CREATE ... IF NOT EXISTS` schema (idempotent, preserves data — this is how a new table lands on an existing DB). **When you add a table: add it to both schema files AND update the probe table name in `db.php`.** The schema files must be saved WITHOUT a UTF-8 BOM (PowerShell `Set-Content -Encoding utf8` adds one; SQLite tolerates it but MySQL rejects the first statement) — the loader now strips a leading BOM defensively, but don't rely on it. Schema *changes* to existing tables can't ride the replay (CREATE IF NOT EXISTS won't alter) — add an idempotent, self-healing migration step instead (see `migrateBudgetsToCadence`: MySQL does in-place guarded ALTERs keyed off the final index; SQLite rebuilds the table since it can't drop a column inside a UNIQUE constraint). New *columns* on existing tables get a guarded `columnExists`-then-`ALTER` step (e.g. `users.email_verified`, added `DEFAULT 1` so pre-existing rows stay verified).
- **Dialect branching**: `Repo::upsertBudget` uses SQLite `ON CONFLICT` vs MySQL `ON DUPLICATE KEY UPDATE` (`DB::driver()`). Keep the `UNIQUE(category_id)` constraint on `budgets` in both schemas or upsert breaks.
- Reset emails go through PHP `mail()`; set `mail_log_file` in config to write them to a file instead (local/test). Deliverability on shared hosting is imperfect — for production, `mail_from` should be a real mailbox on the domain.
- Category delete → transactions `SET NULL` (become "Uncategorized"), budgets `CASCADE`. Users cascade-delete everything.

---

## Deployment (→ Hostinger)

Live at **https://budgettracker.rjsnavarette.com** on **Hostinger shared hosting (hPanel)**, PHP 8.3 (web) + MySQL/MariaDB. Deploys over **SSH with key auth**.

**Process** (from repo root): `npm run build && npm run assemble` produces `deploy/` — the entire uploadable site. Tar it (excluding `api/app/config.php`, `*.sqlite`, `maillog.txt`), scp to the server, extract into the subdomain's `public_html`, remove the stale hashed files in `assets/` first, and `rm router.php`. **Never overwrite the server's `api/app/config.php`** (holds DB creds, chmod 600, not web-accessible). Verify with `GET /api/health` → `{"ok":true,...,"db":true}`. Full step-by-step (including the hPanel/DB/SSL/Google-OAuth setup) is in **`DEPLOY.md`**.

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

## Still optional / not done
- **Google Sign-In** is wired but off by default: set `google_client_id` (Web OAuth client, JS origin = the https subdomain) in the server's `config.php` to enable the button. Email/password works without it.
- Verify production email deliverability; if reset emails land in spam, use a real domain mailbox as `mail_from`.

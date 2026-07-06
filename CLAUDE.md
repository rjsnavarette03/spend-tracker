# CLAUDE.md — SpendTracker

Orientation for an AI agent (or new engineer) working in this repo. Read this first.

## What this repo is

**SpendTracker** — a personal budget / spending / income tracker. It exists as **two separate apps** that share the same UI design and data model:

| App | Location | Stack | Who it's for |
| --- | --- | --- | --- |
| **Desktop** | repo root (`electron/`, `src/`, `shared/`, `scripts/`) | Electron + React + TypeScript, local **SQLite via sql.js** (WASM) | single-user, offline, data stored on the machine |
| **Web** | `web/` | React + TypeScript frontend, **PHP 8 + MySQL** backend | multi-user, accounts (email/password + Google), hosted |

They are independent (separate `package.json`, separate builds). The web app was ported from the desktop app and reuses most components/pages verbatim.

**The web app is deployed live at https://budgettracker.rjsnavarette.com** (Hostinger shared hosting). See “Deployment” below.

Both apps use the same core conventions: **money is stored as integer cents everywhere**, dates are `YYYY-MM-DD` strings and months are `YYYY-MM` strings, and money is only formatted to decimals at the UI edge.

---

## Desktop app (repo root)

React renderer (`src/`) + Electron main process (`electron/`) with a typed IPC bridge. `shared/types.ts` is the single source of truth for the main↔renderer contract (`window.api.*`).

### Commands (run from repo root)
```bash
npm install
npm run dev        # esbuild main+preload, wait for Vite :5173, launch Electron with HMR
npm run build      # typecheck (both tsconfigs) → vite build (dist/) → esbuild main (dist-electron/)
npm run smoke      # headless end-to-end test (see below); writes PASS/FAIL to smoke-result.txt
npm start          # run the built app (needs dist-electron/main.js)
npm run icon       # regenerate buildResources/icon.ico + icon.png (zero-dependency generator)
npm run dist       # build + icon + electron-builder → release/ (Windows NSIS installer + portable exe)
```

### Key files
- `electron/main.ts` — app lifecycle, BrowserWindow, single-instance lock, IPC handler registration, `--smoke-test` mode + demo-data seeding.
- `electron/db.ts` — the whole data layer: sql.js in-memory DB, schema, seeding, validation, queries, reports. Persists the entire DB to disk after every mutation (`export()` → temp file → atomic rename).
- `electron/preload.ts` — exposes the typed `window.api` bridge via `contextBridge` (context isolation on, nodeIntegration off, sandbox on).
- `shared/types.ts` — shared contract types.
- `scripts/build-main.mjs` — esbuild bundle of main+preload; **copies `sql-wasm.wasm` into `dist-electron/`** (required at runtime).
- `scripts/dev.mjs`, `scripts/smoke.mjs`, `scripts/make-icon.mjs`.

### Desktop gotchas
- **sql.js `export()` resets the connection.** After persisting, per-connection state is lost, so `PRAGMA foreign_keys = ON` must be re-applied and `last_insert_rowid()` must be read *before* persisting. `db.ts` already handles this; the smoke test asserts FK actions still fire post-persist.
- **`sql-wasm.wasm` must sit next to `main.js`** in `dist-electron/` at runtime (path is `path.join(__dirname, 'sql-wasm.wasm')`). `build-main.mjs` copies it; a missing binary fails `initDb()`.
- **Single-instance lock** is mandatory — two instances would clobber the in-memory DB’s writes.
- **`npm run icon` must run before `electron-builder`** (it consumes `buildResources/icon.ico`). `npm run dist` does this for you.
- Dev server probe uses `fetch(HEAD)` because Vite’s `localhost` may resolve to IPv6 `::1` on Windows (a raw IPv4 socket check fails).
- The smoke test (`electron/main.ts`, `--smoke-test`) uses an isolated temp DB and supports `--smoke-out=<path>` (writes PASS/FAIL) and `--smoke-shot=<path>` (captures PNG screenshots of each tab). It verifies: DB round trip, FK behavior, React mount, and the renderer→main→DB IPC bridge.

---

## Web app (`web/`)

React SPA (`web/src/`) talking to a small PHP JSON API (`web/server/`) under `/api`. No framework, no Composer. MySQL/MariaDB in production; SQLite supported for local dev. **The schema auto-creates on first request** — no manual import needed.

### Commands (run from `web/`)
```bash
npm install
npm run dev        # Vite dev server on :5174, proxies /api → http://127.0.0.1:8124 (run a PHP server there)
npm run typecheck
npm run build      # typecheck → vite build → web/dist/
npm run assemble   # node scripts/build-deploy.mjs → assembles web/deploy/ (the uploadable site)
npm run test:api   # end-to-end API suite (needs a running server; see below)
```

### Local run + test
```bash
# 1. build the site
npm run build && npm run assemble
# 2. create web/deploy/api/app/config.php from config.sample.php (SQLite is easiest for local):
#    'db' => [ 'dsn' => 'sqlite:' . __DIR__ . '/data.sqlite' ]
#    (optionally) 'mail_log_file' => __DIR__ . '/maillog.txt'   # makes reset emails testable offline
# 3. serve it with PHP's built-in server:
php -S 127.0.0.1:8124 -t deploy deploy/router.php
# 4. run the tests against it:
API_BASE=http://127.0.0.1:8124 MAIL_LOG=./deploy/api/app/maillog.txt node test/api-test.mjs
```
`test/api-test.mjs` is the source of truth for API behavior — a ~66-assertion suite covering auth (register/login/logout, session, CSRF, cross-origin rejection, throttling), CRUD, report math, budgets, foreign-key behavior, cross-user isolation, change-password, and the full forgot→reset flow. It has been run green against **both SQLite and MariaDB**. `MAIL_LOG` (paired with `mail_log_file` in config) lets the reset-token flow be tested without sending real email.

### Key files
- `web/server/api/index.php` — the API front controller. Routing, origin/CSRF checks, dispatch. Uses `ob_start()`/`ob_clean()` so stray whitespace/BOM in `config.php` can’t corrupt headers.
- `web/server/api/app/lib/` — `http.php` (session, CSRF, origin check, rate limiter, JSON), `db.php` (PDO + auto-migration), `auth.php` (register/login/google/logout/change-password/forgot/reset), `repo.php` (all data access, user-scoped), `validate.php`, `mailer.php`.
- `web/server/api/app/config.sample.php` — copy to `config.php` (gitignored) and fill in DB creds + optional `google_client_id` + optional `mail_from`.
- `web/server/schema.mysql.sql` / `schema.sqlite.sql` — schema per dialect.
- `web/server/public/.htaccess` — SPA fallback + `/api` rewrite + security headers (CSP etc.). `web/server/api/app/.htaccess` — denies web access to `app/` (protects `config.php`).
- `web/server/router.php` — local `php -S` router only (harmless in production).
- `web/scripts/build-deploy.mjs` — the `assemble` step.
- `web/src/api.ts` — typed fetch client; holds the CSRF token; dispatches `AUTH_EXPIRED_EVENT` on 401.
- `web/src/AuthGate.tsx` — decides login vs app vs reset screen; reads `?reset=<token>` from the URL.
- `web/src/auth/` (Login, ResetPassword), `web/src/components/AccountModal.tsx` (change/set password), `web/src/pages/`, `web/shared/types.ts`.

### API endpoints (all under `/api`)
```
GET  /health                      → { ok, php, db }
GET  /auth/me                     → { user|null, csrf, googleClientId }
POST /auth/register               { email, password, name }        (pre-auth)
POST /auth/login                  { email, password }              (pre-auth)
POST /auth/google                 { credential }                   (pre-auth)
POST /auth/forgot                 { email } → always { ok:true }   (pre-auth)
POST /auth/reset                  { token, password }              (pre-auth)
POST /auth/logout
POST /auth/change-password        { currentPassword, newPassword } (auth)
GET  /categories                        POST /categories            { name, type, color }
PUT  /categories/:id  { name, color }   DELETE /categories/:id
GET  /transactions?month&type&categoryId&search
POST /transactions   (TxInput)          PUT/DELETE /transactions/:id
GET  /budgets?month                     PUT /budgets { categoryId, month, amountCents }   (0 deletes)
POST /budgets/copy   { month } → { copied }
GET  /reports/summary?month             GET /reports/trend?endMonth&count
GET  /reports/breakdown?month&type
```

### Security model (web)
- Every query in `repo.php` is scoped to the session `user_id`; ownership of referenced categories is verified on write (no IDOR). A transaction/budget cannot reference another user’s category, and a transaction’s category must match its `type`.
- **Authenticated** mutations require an `X-CSRF-Token` header (token from `/auth/me`, rotates on login/change-password). **Pre-auth** mutations (login/register/google/forgot/reset) carry no token, so they use a strict same-origin check via the unforgeable `Sec-Fetch-Site` header (falling back to `Origin`).
- Sessions: HttpOnly, `SameSite=Lax`, `Secure` under HTTPS, `session_regenerate_id` on login/password-change.
- Rate limiting (`auth_throttle` table): per-IP and per-account on login/register/google/forgot/reset.
- Passwords hashed with `password_hash` (`PASSWORD_DEFAULT`). Google ID tokens verified server-side (audience/issuer/expiry/`email_verified`).
- Reset tokens: 32 random bytes, stored only as SHA-256 hash, 1-hour expiry, single-use.

### Web gotchas
- **`config.php` is gitignored and required** — the API returns 500 (“Server not configured”) without it. Always `cp config.sample.php config.php` per environment. `assemble` never creates it (so DB creds can’t be committed) and redeploys must never overwrite it.
- **DB auto-migration**: `DB::ensureSchema` probes the newest table (`password_resets`); if missing it re-runs the full `CREATE ... IF NOT EXISTS` schema (idempotent, preserves data). **When you add a table: add it to both schema files AND update the probe table name in `db.php`.**
- **Dialect branching**: `Repo::upsertBudget` uses SQLite `ON CONFLICT` vs MySQL `ON DUPLICATE KEY UPDATE` (`DB::driver()`). Keep the `UNIQUE(category_id, month)` constraint in both schemas or upsert breaks.
- Reset emails go through PHP `mail()`; set `mail_log_file` in config to write them to a file instead (local/test). Deliverability on shared hosting is imperfect — for production, `mail_from` should be a real mailbox on the domain.
- Category delete → transactions `SET NULL` (become “Uncategorized”), budgets `CASCADE`. Users cascade-delete everything.

---

## Deployment (web app → Hostinger)

Live at **https://budgettracker.rjsnavarette.com** on **Hostinger shared hosting (hPanel)**, PHP 8.3 (web) + MySQL/MariaDB. Deploys over **SSH with key auth**.

**Process** (from `web/`): `npm run build && npm run assemble` produces `web/deploy/` — the entire uploadable site. Tar it (excluding `api/app/config.php`, `*.sqlite`, `maillog.txt`), scp to the server, extract into the subdomain’s `public_html`, remove the stale hashed files in `assets/` first, and `rm router.php`. **Never overwrite the server’s `api/app/config.php`** (holds DB creds, chmod 600, not web-accessible). Verify with `GET /api/health` → `{"ok":true,...,"db":true}`. Full step-by-step (including the hPanel/DB/SSL/Google-OAuth setup) is in **`web/DEPLOY.md`**.

**Secrets are intentionally NOT in this repo.** To deploy/redeploy you need, from the repo owner:
- SSH host / port / username (Hostinger hPanel → Advanced → SSH Access)
- the subdomain document-root path
- MySQL database name / user / password (hPanel → Databases)

The SSH **private key** lives on the owner’s machine at `~/.ssh/hostinger_spendtracker` (its public key is already registered in hPanel); the key itself is never committed. If you are an AI agent with project memory for this repo, these specifics may be recorded there — otherwise ask the owner.

---

## What a fresh clone is missing

Because of `.gitignore`, a fresh checkout does **not** include: `node_modules/` (run `npm install` in root and in `web/`), `dist/` and `dist-electron/` (desktop build outputs), `web/dist/` + `web/deploy/` (run `npm run build && npm run assemble`), any `*.sqlite`, and `web/server/api/app/config.php` (create from `config.sample.php`). None of these belong in git.

## Conventions to preserve

- Integer cents for money, end to end; format only at the UI.
- Keep `shared/types.ts` (desktop) / `web/shared/types.ts` (web) as the contract source of truth.
- Match existing code style (dark theme CSS variables in `styles.css`; no CSS framework). All text-entry inputs are styled by one broad selector — don’t reintroduce per-type input styling.
- When changing API behavior, update `web/test/api-test.mjs` and keep it green on both SQLite and MySQL.

## Still optional / not done
- **Google Sign-In** is wired but off by default: set `google_client_id` (Web OAuth client, JS origin = the https subdomain) in the server’s `config.php` to enable the button. Email/password works without it.
- Verify production email deliverability; if reset emails land in spam, use a real domain mailbox as `mail_from`.

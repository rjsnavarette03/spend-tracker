# SpendTracker (Web)

The web version of SpendTracker — a personal budget, spending and income tracker with multi-user accounts. Sign in with **email + password** or **Google**; each account's data is private and stored in the server's database.

Built to run on **Hostinger shared hosting** (hPanel) with no build tools required on the server.

- **Frontend**: React 18 + TypeScript, bundled by Vite into static files.
- **Backend**: PHP 8 (no framework, no Composer) exposing a small JSON API under `/api`.
- **Database**: MySQL / MariaDB in production (SQLite supported for local dev). Schema auto-creates on first request.
- **Auth**: server-side sessions (HttpOnly cookie) + CSRF tokens; passwords hashed with `password_hash`; Google ID tokens verified server-side.

## What ships to the server

`npm run build && npm run assemble` produces `web/deploy/`, which is the entire site to upload:

```
deploy/
  index.html, assets/, icon.png        ← built React app
  .htaccess                            ← SPA routing + API rewrite + security headers
  router.php                           ← local `php -S` testing only (harmless on server)
  api/
    index.php                          ← API front controller (the only public PHP)
    app/
      .htaccess                        ← denies web access to everything in app/
      config.php                       ← YOU create this (DB creds + Google ID); not in git
      config.sample.php                ← template to copy
      lib/*.php                        ← http, db, validate, auth, repo
      schema.mysql.sql, schema.sqlite.sql
```

See **DEPLOY.md** for the full step-by-step Hostinger deployment guide.

## Local development

```bash
cd web
npm install
npm run dev          # Vite dev server on http://localhost:5174, proxies /api to PHP on :8124
```

For the API during dev you need PHP with `pdo_mysql` or `pdo_sqlite`. Point `api/app/config.php` at a SQLite file for the easiest setup:

```php
'db' => [ 'dsn' => 'sqlite:' . __DIR__ . '/data.sqlite' ],
```

Then serve the assembled folder:

```bash
npm run build && npm run assemble
php -S 127.0.0.1:8124 -t deploy deploy/router.php
```

## Testing

```bash
# start a PHP server on :8124 serving deploy/ (see above), then:
API_BASE=http://127.0.0.1:8124 npm run test:api
```

`test/api-test.mjs` is a 48-assertion end-to-end suite covering auth (register/login/logout, session, CSRF, throttling), full CRUD, report math, budget upsert/copy, foreign-key behavior, and cross-user data isolation. It has been run green against both SQLite and MariaDB 10.4.

## Security model

- Every data query is scoped to the authenticated `user_id`; ownership of referenced categories is verified on write (no IDOR).
- Mutations require a valid CSRF token (`X-CSRF-Token`) plus a same-origin check; the token rotates on login/logout.
- Sessions use an HttpOnly, SameSite=Lax cookie; `Secure` is set automatically under HTTPS. `session_regenerate_id` runs on every login.
- Login/register/Google endpoints are rate-limited per IP (and per email for login).
- Google ID tokens are verified against Google's tokeninfo endpoint with audience, issuer, expiry and `email_verified` checks.
- `api/app/` is blocked from direct web access; `config.php` (with your DB password) is never served.
- Response headers include a strict Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy`.

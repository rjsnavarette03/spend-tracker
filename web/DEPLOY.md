# Deploying SpendTracker to Hostinger (budgettracker.rjsnavarette.com)

This guide gets the app live on your Hostinger shared hosting. Two things must be created in hPanel (subdomain + MySQL database); everything else is uploading files and editing one config file.

There are two paths below — **A** (I deploy for you over SSH) and **B** (you upload it yourself). Pick one.

---

## Prerequisites (either path)

### 1. Create the subdomain
hPanel → **Domains → Subdomains**. Create `budgettracker` under `rjsnavarette.com`.
Note the document root it gives you — typically:

```
/home/uXXXXXXXX/domains/rjsnavarette.com/public_html/budgettracker
```

(Older layouts use `/home/uXXXXXXXX/public_html/budgettracker`.) This folder is where the site's files go.

### 2. Create the MySQL database
hPanel → **Databases → MySQL Databases**. Create:
- a database (e.g. `uXXXXXXXX_spendtracker`)
- a database user with a strong password
- **add the user to the database with ALL privileges**

Write down the four values — you'll put them in `config.php`:
- host: almost always `localhost`
- database name
- database user
- database password

> The app creates its own tables automatically on first visit — you do **not** need to import any SQL. (If you prefer to pre-create them, you can import `api/app/schema.mysql.sql` via phpMyAdmin.)

### 3. Enable HTTPS
hPanel → **Security → SSL**. Install the free SSL certificate for the subdomain and turn on **Force HTTPS**. Sessions and Google sign-in require HTTPS.

---

## Path A — I deploy over SSH/FTP

Send me (paste into the chat, or better, use Hostinger's SSH key upload):
- SSH host + port (hPanel → **Advanced → SSH Access**)
- SSH username and password (or add my key if I give you one)
- the subdomain document root path from step 1
- the four MySQL values from step 2

I'll upload `deploy/`, create `api/app/config.php` with your DB creds, verify the API health check, register a test account, and confirm the live site works end-to-end. I will **not** commit or expose your credentials.

> Security note: rotate the SSH/DB passwords after we're done if you like — the app only needs the DB password to live in `config.php` on the server.

---

## Path B — You upload it yourself

### 1. Build the site (on your PC)
```bash
cd web
npm install
npm run build
npm run assemble
```
This creates `web/deploy/`.

### 2. Create the config file
Copy `deploy/api/app/config.sample.php` to `deploy/api/app/config.php` and fill in your MySQL values from Prerequisite step 2:

```php
return [
    'db' => [
        'dsn'  => 'mysql:host=localhost;dbname=uXXXXXXXX_spendtracker;charset=utf8mb4',
        'user' => 'uXXXXXXXX_dbuser',
        'pass' => 'your-db-password',
    ],
    'google_client_id' => '',   // fill in later (see Google section) or leave '' to disable Google
    'session_name' => 'spendtracker_sid',
];
```

### 3. Upload
Upload the **contents** of `deploy/` (not the folder itself) into the subdomain document root, so the server sees:
```
budgettracker/index.html
budgettracker/assets/...
budgettracker/.htaccess
budgettracker/api/index.php
budgettracker/api/app/config.php
...
```
Use hPanel **File Manager** (zip `deploy` contents, upload, extract) or any FTP client (hPanel → **Files → FTP Accounts** for credentials).

### 4. Verify
Visit `https://budgettracker.rjsnavarette.com/api/health` — you should see:
```json
{"ok":true,"php":"8.x.x","db":true}
```
If `db` is `false`, the DB credentials in `config.php` are wrong. Then open the site, create an account, and you're live.

---

## Enabling Google sign-in (optional, ~5 minutes)

Email/password works without this. To light up the **Continue with Google** button:

1. Go to https://console.cloud.google.com/ and create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in app name (SpendTracker) and your email, save. You can leave it in "Testing" mode — add your own Google account under **Test users** — or publish it.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**: `https://budgettracker.rjsnavarette.com`
   - (No redirect URI is needed — this app uses Google Identity Services one-tap/button.)
   - Create, then copy the **Client ID** (looks like `1234-abcd.apps.googleusercontent.com`).
4. Put it in `config.php`:
   ```php
   'google_client_id' => '1234-abcd.apps.googleusercontent.com',
   ```
5. Reload the site — the Google button appears automatically.

If a user signs in with Google using the same email as an existing password account, the two are linked to one account.

---

## Updating the app later

Rebuild (`npm run build && npm run assemble`) and re-upload everything **except** `api/app/config.php` (keep your existing one). The `assemble` step never generates a `config.php`, so your credentials are safe from being overwritten. Because JS/CSS filenames are content-hashed, browsers pick up the new version immediately.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `/api/health` shows `db:false` | Wrong DB creds in `config.php`, or the user isn't attached to the DB with privileges. |
| 500 error, blank API responses | Check hPanel error logs. Usually a typo in `config.php` or MySQL host ≠ `localhost`. |
| Login works but you're logged out on refresh | HTTPS/`Force HTTPS` not enabled — the secure session cookie needs it. |
| Google button doesn't appear | `google_client_id` is empty, or the JS origin in Google Console doesn't exactly match the https subdomain. |
| Pages 404 on refresh | `.htaccess` didn't upload, or `mod_rewrite` is off (it's on by default on Hostinger). |

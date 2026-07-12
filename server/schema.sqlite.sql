-- SpendTracker schema (SQLite) — used for local development/testing.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NULL,
    google_sub TEXT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    -- DEFAULT 1 grandfathers existing/Google accounts as verified; register()
    -- inserts 0 to force new email/password signups through verification.
    email_verified INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('debit','credit','loan')),
    color TEXT NOT NULL DEFAULT '#38bdf8',
    image TEXT NULL,
    -- Monthly payment due day(s) (1-31) for credit/loan accounts; NULL = none.
    -- due_day2 supports twice-a-month cycles (e.g. 15th + 30th); the server
    -- normalizes so due_day is always the earlier/only day.
    due_day INTEGER NULL,
    due_day2 INTEGER NULL,
    opening_balance_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income','expense')),
    color TEXT NOT NULL DEFAULT '#6366f1'
);

CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income','expense')),
    category_id INTEGER NULL REFERENCES categories(id) ON DELETE SET NULL,
    account_id INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);

CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);

-- NOTE: idx_transactions_account is created in db.php (DB::ensureSchema), NOT
-- here. As a standalone statement it would run during the full-schema replay
-- even on a pre-accounts DB (where CREATE TABLE is skipped), failing with
-- "no such column: account_id". Keeping it out of the replay avoids that.

-- One recurring budget per expense category (see MySQL schema for notes).
CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    cadence TEXT NOT NULL DEFAULT 'month' CHECK (cadence IN ('week','month','year')),
    amount_cents INTEGER NOT NULL,
    UNIQUE (category_id)
);

CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id);

CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_account_id INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
    to_account_id INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    fee_cents INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transfers_user_date ON transfers(user_id, date);

CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_account_id);

CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_account_id);

CREATE TABLE IF NOT EXISTS auth_throttle (
    tkey TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- Pending email verifications: one active row per user (UNIQUE user_id), holding
-- a hashed 6-digit code and a hashed backup link token.
CREATE TABLE IF NOT EXISTS email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
;

-- Recurring subscriptions (see MySQL schema for full notes). Newest table:
-- DB::ensureSchema probes it to decide whether to replay the schema.
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
    category_id INTEGER NULL REFERENCES categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    cycle TEXT NOT NULL CHECK (cycle IN ('monthly','interval')),
    bill_day INTEGER NULL,
    interval_days INTEGER NULL,
    next_date TEXT NOT NULL,
    -- Last cycle date actually charged; updates may never move next_date
    -- back to or before it (prevents stale-client double charges).
    charged_through TEXT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_due ON subscriptions(user_id, active, next_date);

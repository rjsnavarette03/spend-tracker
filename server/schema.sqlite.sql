-- SpendTracker schema (SQLite) — used for local development/testing.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NULL,
    google_sub TEXT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('debit','credit','loan')),
    color TEXT NOT NULL DEFAULT '#38bdf8',
    image TEXT NULL,
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

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)

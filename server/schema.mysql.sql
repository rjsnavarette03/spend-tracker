-- SpendTracker schema (MySQL / MariaDB)
-- Applied automatically on first request; also importable via phpMyAdmin.

CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NULL,
    google_sub VARCHAR(64) NULL,
    name VARCHAR(100) NOT NULL DEFAULT '',
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    -- Email verification. DEFAULT 1 so every pre-existing account (and every
    -- Google account, whose email Google already verified) is treated as
    -- verified; only the email/password register() path inserts 0 to force a
    -- new signup through the verification flow.
    email_verified TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_users_email (email),
    UNIQUE KEY uniq_users_google_sub (google_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(60) NOT NULL,
    type ENUM('debit','credit','loan') NOT NULL,
    color CHAR(7) NOT NULL DEFAULT '#38bdf8',
    image MEDIUMTEXT NULL,
    -- Monthly payment due day(s) (1-31) for credit/loan accounts; NULL = none.
    -- due_day2 supports twice-a-month cycles (e.g. 15th + 30th); the server
    -- normalizes so due_day is always the earlier/only day.
    due_day TINYINT NULL,
    due_day2 TINYINT NULL,
    opening_balance_cents BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_accounts_user (user_id),
    CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(60) NOT NULL,
    type ENUM('income','expense') NOT NULL,
    color CHAR(7) NOT NULL DEFAULT '#6366f1',
    PRIMARY KEY (id),
    KEY idx_categories_user (user_id),
    CONSTRAINT fk_categories_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transactions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    amount_cents BIGINT NOT NULL,
    type ENUM('income','expense') NOT NULL,
    category_id INT UNSIGNED NULL,
    account_id INT UNSIGNED NULL,
    date CHAR(10) NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_transactions_user_date (user_id, date),
    KEY idx_transactions_category (category_id),
    KEY idx_transactions_account (account_id),
    CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_transactions_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    CONSTRAINT fk_transactions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One recurring budget per expense category. `cadence` is the period the
-- amount applies to (weekly / monthly / yearly); there is at most one row
-- per category (UNIQUE), so a category can't hold conflicting budgets.
CREATE TABLE IF NOT EXISTS budgets (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    category_id INT UNSIGNED NOT NULL,
    cadence ENUM('week','month','year') NOT NULL DEFAULT 'month',
    amount_cents BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_budgets_cat (category_id),
    KEY idx_budgets_user (user_id),
    CONSTRAINT fk_budgets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_budgets_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transfers (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    from_account_id INT UNSIGNED NULL,
    to_account_id INT UNSIGNED NULL,
    amount_cents BIGINT NOT NULL,
    fee_cents BIGINT NOT NULL DEFAULT 0,
    date CHAR(10) NOT NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_transfers_user_date (user_id, date),
    KEY idx_transfers_from (from_account_id),
    KEY idx_transfers_to (to_account_id),
    CONSTRAINT fk_transfers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_transfers_from FOREIGN KEY (from_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    CONSTRAINT fk_transfers_to FOREIGN KEY (to_account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_throttle (
    tkey VARCHAR(190) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    window_start INT NOT NULL,
    PRIMARY KEY (tkey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_resets (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_password_resets_token (token_hash),
    KEY idx_password_resets_user (user_id),
    CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pending email verifications: one active row per user (UNIQUE user_id), holding
-- a hashed 6-digit code (typed in the app) and a hashed backup link token
-- (one-click verify). `attempts` caps wrong-code guesses.
CREATE TABLE IF NOT EXISTS email_verifications (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    code_hash CHAR(64) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    expires_at INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_email_verifications_user (user_id),
    UNIQUE KEY uniq_email_verifications_token (token_hash),
    CONSTRAINT fk_email_verifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

-- Recurring subscriptions (Netflix, internet, ...). Auto-charged: when
-- next_date <= today, Repo::processDueSubscriptions inserts an expense
-- transaction on the linked account (dated next_date) and advances next_date
-- by one cycle -- 'monthly' re-lands on bill_day (clamped to short months),
-- 'interval' adds interval_days. account_id SET NULL on account delete =
-- charging pauses until the user relinks. Newest table, so DB::ensureSchema
-- probes it to decide whether to replay the schema.
CREATE TABLE IF NOT EXISTS subscriptions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    account_id INT UNSIGNED NULL,
    category_id INT UNSIGNED NULL,
    name VARCHAR(100) NOT NULL,
    amount_cents BIGINT NOT NULL,
    cycle ENUM('monthly','interval','yearly') NOT NULL,
    bill_day TINYINT NULL,
    interval_days SMALLINT NULL,
    next_date DATE NOT NULL,
    -- Last cycle date actually charged; updates may never move next_date
    -- back to or before it (prevents stale-client double charges).
    charged_through DATE NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_subscriptions_user_due (user_id, active, next_date),
    CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscriptions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    CONSTRAINT fk_subscriptions_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
    -- Reminder emails (opt-in, off by default). timezone is the browser's IANA
    -- zone saved when turned on, so "7 AM" is the user's 7 AM.
    -- reminders_run_on is the user's local date of the last daily check (one
    -- email a day at most). reminder_token goes in every email's unsubscribe
    -- link; it can only turn reminders off, so it's stored as-is.
    reminder_emails TINYINT(1) NOT NULL DEFAULT 0,
    timezone VARCHAR(64) NULL,
    reminders_run_on DATE NULL,
    reminder_token CHAR(64) NULL,
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
    -- Credit cards: the limit and the day of the month the statement closes.
    -- Cards and loans: yearly interest rate in basis points (3600 = 36%),
    -- NULL = none (installments that already include their interest).
    credit_limit_cents BIGINT NULL,
    statement_day TINYINT NULL,
    interest_rate_bp INT NULL,
    opening_balance_cents BIGINT NOT NULL DEFAULT 0,
    -- Set when a settled (balance 0) account is archived: hidden from the
    -- account lists and pickers, history untouched. Any new transaction or
    -- transfer on it clears this again. DATETIME, not TIMESTAMP, so MySQL
    -- never auto-fills it.
    archived_at DATETIME NULL,
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
    time CHAR(5) NULL,
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
    time CHAR(5) NULL,
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
-- charging pauses until the user relinks.
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

-- Payment schedule (the Schedule page). One row per payday (kind 'income')
-- or planned outflow. Loans and cards take their due days from the linked
-- account; bills, savings and paydays carry their own due_day; allowances
-- recur weekly on week_day. Subscriptions are auto-charged by their own
-- table, so a 'subscription' row only records which payday funds it.
-- Nothing here is a ledger entry: paying creates an ordinary transfer or
-- transaction, linked back through schedule_payments.
CREATE TABLE IF NOT EXISTS schedule_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    kind ENUM('income','loan','card','bill','allowance','savings','subscription') NOT NULL,
    -- loan/card: the account being paid. savings: the destination account.
    -- income: the account the salary lands in.
    account_id INT UNSIGNED NULL,
    subscription_id INT UNSIGNED NULL,
    category_id INT UNSIGNED NULL,
    -- 'avg3' (bills only): the estimate is the average monthly spend in
    -- category_id over the last 3 complete months, optionally only notes
    -- containing match_keyword (which also tells the client which category
    -- expenses count as paying this bill). amount_cents is the fallback
    -- with no history.
    amount_mode ENUM('fixed','avg3') NOT NULL DEFAULT 'fixed',
    amount_cents BIGINT NOT NULL DEFAULT 0,
    match_keyword VARCHAR(60) NULL,
    due_day TINYINT NULL,
    week_day TINYINT NULL,
    -- The income item (payday) that funds this one. NULL = automatic. Not an
    -- FK: deleting a payday NULLs these in Repo::deleteScheduleItem.
    funded_by INT UNSIGNED NULL,
    weekend_shift ENUM('none','before','after') NOT NULL DEFAULT 'none',
    -- Occurrences before start_date are not tracked (never shown overdue).
    start_date DATE NOT NULL,
    end_date DATE NULL,
    goal_cents BIGINT NULL,
    -- Savings checkpoints on the way to goal_cents: comma-separated cents,
    -- ascending (e.g. "1000000,3000000"); NULL = none. Added after the table
    -- first shipped, so DB::ensureSchema also ALTERs it onto older databases.
    goal_milestones VARCHAR(255) NULL,
    pay_from_account_id INT UNSIGNED NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_schedule_items_user (user_id),
    UNIQUE KEY uniq_schedule_items_sub (subscription_id),
    CONSTRAINT fk_schedule_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_items_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    CONSTRAINT fk_schedule_items_sub FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_items_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    CONSTRAINT fk_schedule_items_pay_from FOREIGN KEY (pay_from_account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Links one occurrence (item + due_date) to the transfer or transaction that
-- settled it. Amounts are read from the linked row, never copied, so editing
-- the payment in Transactions can't leave a stale figure here. Deleting the
-- payment deletes the link (status reverts).
CREATE TABLE IF NOT EXISTS schedule_payments (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    item_id INT UNSIGNED NOT NULL,
    due_date DATE NOT NULL,
    transfer_id INT UNSIGNED NULL,
    transaction_id INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_schedule_payments_user_due (user_id, due_date),
    KEY idx_schedule_payments_item (item_id, due_date),
    KEY idx_schedule_payments_transfer (transfer_id),
    KEY idx_schedule_payments_tx (transaction_id),
    CONSTRAINT fk_schedule_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_payments_item FOREIGN KEY (item_id) REFERENCES schedule_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_payments_transfer FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_payments_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reminders already emailed, one row per reminder key ('soon|12|2026-11-05':
-- stage|item|due date), so each stage of a due date is emailed once. Rows
-- older than 90 days are pruned by the reminders job. Newest table, so
-- DB::ensureSchema probes it to decide whether to replay the schema.
CREATE TABLE IF NOT EXISTS reminder_sends (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    reminder_key VARCHAR(100) NOT NULL,
    sent_on DATE NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_reminder_sends_key (user_id, reminder_key),
    KEY idx_reminder_sends_sent (sent_on),
    CONSTRAINT fk_reminder_sends_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

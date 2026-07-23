<?php
declare(strict_types=1);

final class DB
{
    private static ?PDO $pdo = null;
    /** @var array<string, mixed> */
    private static array $cfg = [];

    /** @param array<string, mixed> $cfg */
    public static function init(array $cfg): void
    {
        self::$cfg = $cfg;
    }

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $dsn = (string)self::$cfg['dsn'];
            $pdo = new PDO(
                $dsn,
                isset(self::$cfg['user']) ? (string)self::$cfg['user'] : null,
                isset(self::$cfg['pass']) ? (string)self::$cfg['pass'] : null,
                [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]
            );
            if (str_starts_with($dsn, 'sqlite:')) {
                $pdo->exec('PRAGMA foreign_keys = ON');
            }
            self::$pdo = $pdo;
            self::ensureSchema();
        }
        return self::$pdo;
    }

    public static function driver(): string
    {
        return (string)self::pdo()->getAttribute(PDO::ATTR_DRIVER_NAME);
    }

    /**
     * Run a DDL statement, tolerating "already exists" / "duplicate" errors.
     * Makes migration idempotent and self-healing: concurrent first-requests
     * and re-runs after a partially-applied upgrade converge instead of
     * throwing a 500. Any non-benign error is re-thrown.
     */
    private static function tryDdl(string $sql): void
    {
        assert(self::$pdo !== null);
        try {
            self::$pdo->exec($sql);
        } catch (PDOException $e) {
            // Prefer the driver error CODE over the message: MySQL/MariaDB
            // localize error text (lc_messages), so English substring matching
            // would misclassify a benign "duplicate column" as fatal and 500
            // on a non-English server. Codes are locale-independent.
            //   1050 table exists · 1060 dup column · 1061 dup key/index name
            //   1091 can't drop (already gone) · 1826/121 dup constraint name
            $code = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
            $benignMysql = [1050, 1060, 1061, 1091, 1826, 121];
            // SQLite (dev/test only) never localizes, so message matching is
            // safe there and also covers English MySQL as a belt-and-braces.
            $msg = strtolower($e->getMessage());
            $benign = in_array($code, $benignMysql, true)
                || str_contains($msg, 'already exists')
                || str_contains($msg, 'duplicate column')
                || str_contains($msg, 'duplicate key')
                || str_contains($msg, 'duplicate foreign key')
                || str_contains($msg, 'errno: 121');
            if (!$benign) {
                throw $e;
            }
        }
    }

    /**
     * Auto-migrate on first use. Idempotent and self-healing — safe to run on
     * every connection, under concurrency, and after a partially-applied
     * upgrade (see tryDdl).
     *   1. If the newest table (`subscriptions`) is missing, replay the
     *      full dialect schema (all CREATE ... IF NOT EXISTS — data preserved).
     *   2. Add columns that CREATE IF NOT EXISTS can't express — currently
     *      transactions.account_id, driven off the artifact that is created
     *      last (the FK on MySQL) so an interrupted upgrade re-completes.
     */
    private static function ensureSchema(): void
    {
        assert(self::$pdo !== null);
        $driver = (string)self::$pdo->getAttribute(PDO::ATTR_DRIVER_NAME);

        // Step 1: create any missing tables. Probe the newest table
        // (subscriptions); if it's absent, replay the whole schema.
        $hasNewest = true;
        try {
            self::$pdo->query('SELECT 1 FROM subscriptions LIMIT 1');
        } catch (PDOException) {
            $hasNewest = false;
        }
        if (!$hasNewest) {
            $file = __DIR__ . '/../schema.' . ($driver === 'sqlite' ? 'sqlite' : 'mysql') . '.sql';
            $sql = file_get_contents($file);
            if ($sql === false) {
                throw new RuntimeException("Schema file missing: $file");
            }
            // A UTF-8 BOM (editors add them silently) glues onto the first
            // statement after splitting; SQLite ignores it but MySQL errors.
            $sql = (string)preg_replace('/^\xEF\xBB\xBF/', '', $sql);
            // Strip -- comment lines first: a comment and the statement after
            // it share a chunk when splitting on ';'.
            $sql = (string)preg_replace('/^\s*--.*$/m', '', $sql);
            foreach (explode(';', $sql) as $statement) {
                $statement = trim($statement);
                if ($statement !== '') {
                    self::tryDdl($statement);
                }
            }
        }

        // Step 2: transactions.account_id (added with the accounts feature).
        $hasAccountId = true;
        try {
            self::$pdo->query('SELECT account_id FROM transactions LIMIT 1');
        } catch (PDOException) {
            $hasAccountId = false;
        }

        if ($driver === 'sqlite') {
            if (!$hasAccountId) {
                self::tryDdl(
                    'ALTER TABLE transactions ADD COLUMN account_id INTEGER NULL
                     REFERENCES accounts(id) ON DELETE SET NULL'
                );
            }
            // Standalone in db.php (NOT the schema file) so the step-1 replay
            // never references account_id on a table that predates it.
            self::tryDdl(
                'CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)'
            );
        } else {
            // Drive off the FK (created last), so an interrupted upgrade that
            // left the column but not the index/FK re-completes on a later run.
            $fkExists = (int) self::$pdo->query(
                "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
                 WHERE CONSTRAINT_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'transactions'
                   AND CONSTRAINT_NAME = 'fk_transactions_account'"
            )->fetchColumn();
            if ($fkExists === 0) {
                if (!$hasAccountId) {
                    self::tryDdl('ALTER TABLE transactions ADD COLUMN account_id INT UNSIGNED NULL');
                }
                self::tryDdl('ALTER TABLE transactions ADD KEY idx_transactions_account (account_id)');
                self::tryDdl(
                    'ALTER TABLE transactions ADD CONSTRAINT fk_transactions_account
                     FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL'
                );
            }
        }

        // Step 3: users.currency (added with the per-user currency setting).
        try {
            self::$pdo->query('SELECT currency FROM users LIMIT 1');
        } catch (PDOException) {
            $col = $driver === 'sqlite'
                ? "ALTER TABLE users ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'"
                : "ALTER TABLE users ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'";
            self::tryDdl($col);
        }

        // Step 4: accounts.image (added with the custom account image feature).
        try {
            self::$pdo->query('SELECT image FROM accounts LIMIT 1');
        } catch (PDOException) {
            $col = $driver === 'sqlite'
                ? 'ALTER TABLE accounts ADD COLUMN image TEXT NULL'
                : 'ALTER TABLE accounts ADD COLUMN image MEDIUMTEXT NULL';
            self::tryDdl($col);
        }

        // Step 5: budgets month -> cadence (per-category recurring budgets).
        // The old model keyed a budget to a specific YYYY-MM (one row per
        // category per month). The new model is a single recurring rule per
        // category with a cadence (week/month/year). Migrate by collapsing each
        // category's rows to its most recent month's amount, cadence 'month'.
        self::migrateBudgetsToCadence($driver);

        // Step 6: users.email_verified (email verification on registration).
        // Added with DEFAULT 1 so every account that predates this feature is
        // grandfathered as verified and never locked out; the register() path
        // explicitly inserts 0 to force new email/password signups through
        // verification. (The email_verifications table itself is created by the
        // step-1 replay, which the probe above triggers when it's missing.)
        if (!self::columnExists('users', 'email_verified')) {
            $col = $driver === 'sqlite'
                ? 'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1'
                : 'ALTER TABLE users ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 1';
            self::tryDdl($col);
        }

        // Step 7: accounts.due_day / due_day2 (monthly payment due days for
        // credit/loan accounts; NULL = none; due_day2 = twice-a-month cycles).
        if (!self::columnExists('accounts', 'due_day')) {
            $col = $driver === 'sqlite'
                ? 'ALTER TABLE accounts ADD COLUMN due_day INTEGER NULL'
                : 'ALTER TABLE accounts ADD COLUMN due_day TINYINT NULL';
            self::tryDdl($col);
        }
        if (!self::columnExists('accounts', 'due_day2')) {
            $col = $driver === 'sqlite'
                ? 'ALTER TABLE accounts ADD COLUMN due_day2 INTEGER NULL'
                : 'ALTER TABLE accounts ADD COLUMN due_day2 TINYINT NULL';
            self::tryDdl($col);
        }

        // Step 8: subscriptions.cycle gained 'yearly'. The first release
        // shipped a two-value enum/CHECK, which CREATE IF NOT EXISTS can't
        // widen — detect and widen idempotently.
        self::migrateSubscriptionCycleYearly($driver);

        // Step 9: transactions.time / transfers.time (optional HH:MM,
        // client-local — same string convention as `date`). NULL for rows
        // that predate the feature and for subscription auto-charges (no
        // known time-of-day).
        if (!self::columnExists('transactions', 'time')) {
            $col = $driver === 'sqlite'
                ? 'ALTER TABLE transactions ADD COLUMN time TEXT NULL'
                : 'ALTER TABLE transactions ADD COLUMN time CHAR(5) NULL';
            self::tryDdl($col);
        }
        if (!self::columnExists('transfers', 'time')) {
            $col = $driver === 'sqlite'
                ? 'ALTER TABLE transfers ADD COLUMN time TEXT NULL'
                : 'ALTER TABLE transfers ADD COLUMN time CHAR(5) NULL';
            self::tryDdl($col);
        }
    }

    /**
     * Widen subscriptions.cycle to include 'yearly'.
     *  - MySQL: read COLUMN_TYPE from information_schema; MODIFY the enum
     *    in place when 'yearly' is missing (no data change).
     *  - SQLite: a CHECK constraint can't be altered — rebuild the table
     *    (same pattern as migrateBudgetsToCadence). SQLite is dev/test only.
     */
    private static function migrateSubscriptionCycleYearly(string $driver): void
    {
        assert(self::$pdo !== null);

        if ($driver === 'sqlite') {
            $row = self::$pdo
                ->query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'")
                ->fetch();
            if ($row === false || str_contains((string)$row['sql'], "'yearly'")) {
                return;
            }
            self::tryDdl(
                "CREATE TABLE IF NOT EXISTS subscriptions_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    account_id INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL,
                    category_id INTEGER NULL REFERENCES categories(id) ON DELETE SET NULL,
                    name TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    cycle TEXT NOT NULL CHECK (cycle IN ('monthly','interval','yearly')),
                    bill_day INTEGER NULL,
                    interval_days INTEGER NULL,
                    next_date TEXT NOT NULL,
                    charged_through TEXT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )"
            );
            self::tryDdl(
                'INSERT INTO subscriptions_new (id, user_id, account_id, category_id, name, amount_cents, cycle, bill_day, interval_days, next_date, charged_through, active, created_at)
                 SELECT id, user_id, account_id, category_id, name, amount_cents, cycle, bill_day, interval_days, next_date, charged_through, active, created_at FROM subscriptions'
            );
            self::tryDdl('DROP TABLE subscriptions');
            self::tryDdl('ALTER TABLE subscriptions_new RENAME TO subscriptions');
            self::tryDdl(
                'CREATE INDEX IF NOT EXISTS idx_subscriptions_user_due ON subscriptions(user_id, active, next_date)'
            );
            return;
        }

        try {
            $row = self::$pdo
                ->query(
                    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'cycle'"
                )
                ->fetch();
        } catch (PDOException) {
            return; // table missing — the step-1 replay creates it correctly
        }
        if ($row === false || str_contains((string)$row['t'], 'yearly')) {
            return;
        }
        self::tryDdl(
            "ALTER TABLE subscriptions MODIFY cycle ENUM('monthly','interval','yearly') NOT NULL"
        );
    }

    /** True if `SELECT $col FROM $table` works (i.e. the column exists). */
    private static function columnExists(string $table, string $col): bool
    {
        assert(self::$pdo !== null);
        try {
            self::$pdo->query("SELECT $col FROM $table LIMIT 1");
            return true;
        } catch (PDOException) {
            return false;
        }
    }

    /** MySQL/MariaDB: does a named index exist on $table? */
    private static function mysqlIndexExists(string $table, string $index): bool
    {
        assert(self::$pdo !== null);
        return (int) self::$pdo->query(
            "SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = '$table'
               AND INDEX_NAME = '$index'"
        )->fetchColumn() > 0;
    }

    /**
     * Idempotent, self-healing migration of the budgets table from the
     * month-keyed model to the recurring per-category cadence model.
     *  - MySQL: in-place ALTERs (the table never disappears). Driven off the
     *    new UNIQUE index (added LAST) as the "done" marker, with every step
     *    individually guarded, so a run interrupted part-way re-completes.
     *  - SQLite: can't DROP a column that participates in a UNIQUE constraint,
     *    so the table is rebuilt. Nothing references budgets via FK, so this is
     *    safe. SQLite is dev/test only.
     */
    private static function migrateBudgetsToCadence(string $driver): void
    {
        assert(self::$pdo !== null);

        if ($driver === 'sqlite') {
            // Fresh DBs already have cadence; only legacy month-keyed DBs migrate.
            if (self::columnExists('budgets', 'cadence') || !self::columnExists('budgets', 'month')) {
                return;
            }
            self::tryDdl(
                "CREATE TABLE IF NOT EXISTS budgets_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                    cadence TEXT NOT NULL DEFAULT 'month' CHECK (cadence IN ('week','month','year')),
                    amount_cents INTEGER NOT NULL,
                    UNIQUE (category_id)
                 )"
            );
            // Keep each category's most-recent month amount as its monthly rule.
            self::tryDdl(
                "INSERT INTO budgets_new (id, user_id, category_id, cadence, amount_cents)
                 SELECT b.id, b.user_id, b.category_id, 'month', b.amount_cents
                 FROM budgets b
                 WHERE b.month = (SELECT MAX(b2.month) FROM budgets b2 WHERE b2.category_id = b.category_id)"
            );
            self::tryDdl('DROP TABLE budgets');
            self::tryDdl('ALTER TABLE budgets_new RENAME TO budgets');
            self::tryDdl('CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id)');
            return;
        }

        // MySQL / MariaDB. Fully migrated once cadence exists AND the legacy
        // month column is gone — dropping month is the last correctness-
        // critical step (upsert INSERTs omit month; a lingering NOT NULL month
        // would reject them), so it's the right "done" marker.
        if (self::columnExists('budgets', 'cadence') && !self::columnExists('budgets', 'month')) {
            return;
        }
        if (!self::columnExists('budgets', 'cadence')) {
            self::tryDdl("ALTER TABLE budgets ADD COLUMN cadence ENUM('week','month','year') NOT NULL DEFAULT 'month'");
        }
        if (self::columnExists('budgets', 'month')) {
            // Collapse to one row per category: drop every row that has a newer
            // month (tie-break: higher id) for the same category. Must run
            // before the new UNIQUE(category_id) index can be added.
            self::tryDdl(
                'DELETE b1 FROM budgets b1
                 JOIN budgets b2 ON b1.category_id = b2.category_id
                   AND (b2.month > b1.month OR (b2.month = b1.month AND b2.id > b1.id))'
            );
        }
        // Add the new index BEFORE dropping the old one: the category_id
        // foreign key needs an index to lean on, and MySQL refuses to drop
        // uniq_budgets_cat_month (errno 1553) while it's the FK's only backing
        // index. uniq_budgets_cat gives the FK somewhere else to land first.
        if (!self::mysqlIndexExists('budgets', 'uniq_budgets_cat')) {
            self::tryDdl('ALTER TABLE budgets ADD UNIQUE KEY uniq_budgets_cat (category_id)');
        }
        if (self::mysqlIndexExists('budgets', 'uniq_budgets_cat_month')) {
            self::tryDdl('ALTER TABLE budgets DROP INDEX uniq_budgets_cat_month');
        }
        if (self::columnExists('budgets', 'month')) {
            self::tryDdl('ALTER TABLE budgets DROP COLUMN month');
        }
    }

    /**
     * @param array<int, mixed> $params
     * @return array<int, array<string, mixed>>
     */
    public static function all(string $sql, array $params = []): array
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    /**
     * @param array<int, mixed> $params
     * @return array<string, mixed>|null
     */
    public static function one(string $sql, array $params = []): ?array
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    /** @param array<int, mixed> $params */
    public static function exec(string $sql, array $params = []): int
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    /** @param array<int, mixed> $params */
    public static function insert(string $sql, array $params = []): int
    {
        self::exec($sql, $params);
        return (int)self::pdo()->lastInsertId();
    }
}

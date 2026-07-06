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
            $msg = strtolower($e->getMessage());
            $benign = str_contains($msg, 'already exists')
                || str_contains($msg, 'duplicate column')
                || str_contains($msg, 'duplicate key')
                || str_contains($msg, 'duplicate foreign key')
                || str_contains($msg, 'errno: 121'); // MySQL duplicate constraint name
            if (!$benign) {
                throw $e;
            }
        }
    }

    /**
     * Auto-migrate on first use. Idempotent and self-healing — safe to run on
     * every connection, under concurrency, and after a partially-applied
     * upgrade (see tryDdl).
     *   1. If the newest table (`transfers`) is missing, replay the full
     *      dialect schema (all CREATE ... IF NOT EXISTS — data preserved).
     *   2. Add columns that CREATE IF NOT EXISTS can't express — currently
     *      transactions.account_id, driven off the artifact that is created
     *      last (the FK on MySQL) so an interrupted upgrade re-completes.
     */
    private static function ensureSchema(): void
    {
        assert(self::$pdo !== null);
        $driver = (string)self::$pdo->getAttribute(PDO::ATTR_DRIVER_NAME);

        // Step 1: create any missing tables.
        $hasTransfers = true;
        try {
            self::$pdo->query('SELECT 1 FROM transfers LIMIT 1');
        } catch (PDOException) {
            $hasTransfers = false;
        }
        if (!$hasTransfers) {
            $file = __DIR__ . '/../schema.' . ($driver === 'sqlite' ? 'sqlite' : 'mysql') . '.sql';
            $sql = file_get_contents($file);
            if ($sql === false) {
                throw new RuntimeException("Schema file missing: $file");
            }
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

<?php
declare(strict_types=1);

/**
 * All data access. Every query is scoped to the signed-in user's id;
 * ownership of referenced rows (categories on transactions/budgets) is
 * verified before writes.
 */
final class Repo
{
    private const DEFAULT_CATEGORIES = [
        ['Salary', 'income', '#34d399'],
        ['Freelance', 'income', '#2dd4bf'],
        ['Investments', 'income', '#a78bfa'],
        ['Other Income', 'income', '#94a3b8'],
        ['Housing', 'expense', '#f97316'],
        ['Groceries', 'expense', '#84cc16'],
        ['Transport', 'expense', '#38bdf8'],
        ['Utilities', 'expense', '#eab308'],
        ['Dining Out', 'expense', '#fb7185'],
        ['Entertainment', 'expense', '#c084fc'],
        ['Health', 'expense', '#f43f5e'],
        ['Shopping', 'expense', '#f59e0b'],
        ['Subscriptions', 'expense', '#818cf8'],
        ['Other', 'expense', '#94a3b8'],
    ];

    public static function seedDefaultCategories(int $uid): void
    {
        foreach (self::DEFAULT_CATEGORIES as [$name, $type, $color]) {
            DB::exec(
                'INSERT INTO categories (user_id, name, type, color) VALUES (?, ?, ?, ?)',
                [$uid, $name, $type, $color]
            );
        }
    }

    // ---------- categories ----------

    /** @return array<int, array<string, mixed>> */
    public static function listCategories(int $uid): array
    {
        $rows = DB::all(
            'SELECT c.id, c.name, c.type, c.color, COUNT(t.id) AS txCount
             FROM categories c
             LEFT JOIN transactions t ON t.category_id = c.id
             WHERE c.user_id = ?
             GROUP BY c.id, c.name, c.type, c.color
             ORDER BY c.type, LOWER(c.name)',
            [$uid]
        );
        return array_map(static fn(array $r): array => [
            'id' => (int)$r['id'],
            'name' => (string)$r['name'],
            'type' => (string)$r['type'],
            'color' => (string)$r['color'],
            'txCount' => (int)$r['txCount'],
        ], $rows);
    }

    /** @return array<string, mixed> */
    public static function createCategory(int $uid, mixed $name, mixed $type, mixed $color): array
    {
        $name = Validate::name($name);
        $type = Validate::type($type);
        $color = Validate::color($color);
        $id = DB::insert(
            'INSERT INTO categories (user_id, name, type, color) VALUES (?, ?, ?, ?)',
            [$uid, $name, $type, $color]
        );
        return ['id' => $id, 'name' => $name, 'type' => $type, 'color' => $color, 'txCount' => 0];
    }

    public static function updateCategory(int $uid, int $id, mixed $name, mixed $color): void
    {
        $name = Validate::name($name);
        $color = Validate::color($color);
        $count = DB::exec(
            'UPDATE categories SET name = ?, color = ? WHERE id = ? AND user_id = ?',
            [$name, $color, $id, $uid]
        );
        if ($count === 0 && DB::one('SELECT id FROM categories WHERE id = ? AND user_id = ?', [$id, $uid]) === null) {
            throw new ApiError('Category not found', 404);
        }
    }

    public static function deleteCategory(int $uid, int $id): void
    {
        // FK actions: transactions.category_id -> NULL, budget rows -> deleted.
        $count = DB::exec('DELETE FROM categories WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($count === 0) {
            throw new ApiError('Category not found', 404);
        }
    }

    private static function assertCategoryOwned(int $uid, int $categoryId, ?string $type = null): void
    {
        $sql = 'SELECT id FROM categories WHERE id = ? AND user_id = ?';
        $params = [$categoryId, $uid];
        if ($type !== null) {
            $sql .= ' AND type = ?';
            $params[] = $type;
        }
        if (DB::one($sql, $params) === null) {
            throw new ApiError('Invalid category', 422);
        }
    }

    // ---------- transactions ----------

    /**
     * @param array<string, mixed> $filter
     * @return array<int, array<string, mixed>>
     */
    public static function listTransactions(int $uid, array $filter): array
    {
        $where = ['t.user_id = ?'];
        $params = [$uid];

        if (isset($filter['month']) && $filter['month'] !== '') {
            $where[] = 'SUBSTR(t.date, 1, 7) = ?';
            $params[] = Validate::month($filter['month']);
        }
        if (isset($filter['type']) && $filter['type'] !== '' && $filter['type'] !== 'all') {
            $where[] = 't.type = ?';
            $params[] = Validate::type($filter['type']);
        }
        if (isset($filter['categoryId']) && $filter['categoryId'] !== '' && $filter['categoryId'] !== 'all') {
            $where[] = 't.category_id = ?';
            $params[] = Validate::intId($filter['categoryId']);
        }
        if (isset($filter['accountId']) && $filter['accountId'] !== '' && $filter['accountId'] !== 'all') {
            $where[] = 't.account_id = ?';
            $params[] = Validate::intId($filter['accountId']);
        }
        if (isset($filter['from']) && $filter['from'] !== '') {
            $where[] = 't.date >= ?';
            $params[] = Validate::date($filter['from']);
        }
        if (isset($filter['to']) && $filter['to'] !== '') {
            $where[] = 't.date <= ?';
            $params[] = Validate::date($filter['to']);
        }
        $search = trim((string)($filter['search'] ?? ''));
        if ($search !== '') {
            $like = '%' . strtolower(mb_substr($search, 0, 100)) . '%';
            $where[] = "(LOWER(t.note) LIKE ? OR LOWER(COALESCE(c.name, '')) LIKE ?)";
            $params[] = $like;
            $params[] = $like;
        }

        $rows = DB::all(
            // time DESC puts NULLs (legacy rows / no time given) last within a
            // day on BOTH dialects (NULL sorts smallest), then id breaks ties.
            'SELECT t.id, t.amount_cents AS amountCents, t.type, t.category_id AS categoryId,
                    t.account_id AS accountId, t.date, t.time, t.note,
                    c.name AS categoryName, c.color AS categoryColor,
                    a.name AS accountName, a.color AS accountColor
             FROM transactions t
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN accounts a ON a.id = t.account_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY t.date DESC, t.time DESC, t.id DESC
             LIMIT 2000',
            $params
        );
        return array_map([self::class, 'castTx'], $rows);
    }

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function castTx(array $r): array
    {
        return [
            'id' => (int)$r['id'],
            'amountCents' => (int)$r['amountCents'],
            'type' => (string)$r['type'],
            'categoryId' => $r['categoryId'] === null ? null : (int)$r['categoryId'],
            'date' => (string)$r['date'],
            'time' => $r['time'] === null ? null : (string)$r['time'],
            'note' => (string)$r['note'],
            'categoryName' => $r['categoryName'] === null ? null : (string)$r['categoryName'],
            'categoryColor' => $r['categoryColor'] === null ? null : (string)$r['categoryColor'],
            'accountId' => $r['accountId'] === null ? null : (int)$r['accountId'],
            'accountName' => $r['accountName'] === null ? null : (string)$r['accountName'],
            'accountColor' => $r['accountColor'] === null ? null : (string)$r['accountColor'],
        ];
    }

    /**
     * @param array<string, mixed> $data
     * @return array{0: int, 1: string, 2: ?int, 3: ?int, 4: string, 5: ?string, 6: string} amount, type, categoryId, accountId, date, time, note
     */
    private static function cleanTxInput(int $uid, array $data): array
    {
        $amount = Validate::amountCents($data['amountCents'] ?? null);
        $type = Validate::type($data['type'] ?? null);
        $categoryId = Validate::categoryIdOrNull($data['categoryId'] ?? null);
        $accountId = Validate::accountIdOrNull($data['accountId'] ?? null);
        $date = Validate::date($data['date'] ?? null);
        $time = Validate::timeHmOrNull($data['time'] ?? null);
        $note = Validate::note($data['note'] ?? '');
        if ($categoryId !== null) {
            // Category must belong to the user AND match the tx type, so an
            // income tx can't reference an expense category (would corrupt
            // the by-category breakdown). Mirrors the upsertBudget check.
            self::assertCategoryOwned($uid, $categoryId, $type);
        }
        if ($accountId !== null) {
            // Loans are managed purely via transfers (Pay / Borrow again);
            // the UI never offers them here, so enforce it server-side too.
            if (self::assertAccountOwned($uid, $accountId) === 'loan') {
                throw new ApiError('Transactions cannot be linked to a loan account', 422);
            }
        }
        return [$amount, $type, $categoryId, $accountId, $date, $time, $note];
    }

    /**
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function createTransaction(int $uid, array $data): array
    {
        [$amount, $type, $categoryId, $accountId, $date, $time, $note] = self::cleanTxInput($uid, $data);
        $id = DB::insert(
            'INSERT INTO transactions (user_id, amount_cents, type, category_id, account_id, date, time, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$uid, $amount, $type, $categoryId, $accountId, $date, $time, $note]
        );
        self::restoreOnActivity($uid, $accountId);
        $row = DB::one(
            'SELECT t.id, t.amount_cents AS amountCents, t.type, t.category_id AS categoryId,
                    t.account_id AS accountId, t.date, t.time, t.note,
                    c.name AS categoryName, c.color AS categoryColor,
                    a.name AS accountName, a.color AS accountColor
             FROM transactions t
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN accounts a ON a.id = t.account_id
             WHERE t.id = ? AND t.user_id = ?',
            [$id, $uid]
        );
        assert($row !== null);
        return self::castTx($row);
    }

    /** @param array<string, mixed> $data */
    public static function updateTransaction(int $uid, int $id, array $data): void
    {
        [$amount, $type, $categoryId, $accountId, $date, $time, $note] = self::cleanTxInput($uid, $data);
        if (DB::one('SELECT id FROM transactions WHERE id = ? AND user_id = ?', [$id, $uid]) === null) {
            throw new ApiError('Transaction not found', 404);
        }
        DB::exec(
            'UPDATE transactions SET amount_cents = ?, type = ?, category_id = ?, account_id = ?, date = ?, time = ?, note = ?
             WHERE id = ? AND user_id = ?',
            [$amount, $type, $categoryId, $accountId, $date, $time, $note, $id, $uid]
        );
    }

    public static function deleteTransaction(int $uid, int $id): void
    {
        $count = DB::exec('DELETE FROM transactions WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($count === 0) {
            throw new ApiError('Transaction not found', 404);
        }
    }

    // ---------- accounts ----------

    /**
     * Live balance of account `a`:
     *   opening + income tx − expense tx − (outgoing transfers + fees) + incoming transfers
     * Positive = money you have; negative = money you owe (credit/loan).
     */
    private const BALANCE_SQL =
        "a.opening_balance_cents
         + COALESCE((SELECT SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END)
                     FROM transactions t WHERE t.account_id = a.id), 0)
         - COALESCE((SELECT SUM(tro.amount_cents + tro.fee_cents)
                     FROM transfers tro WHERE tro.from_account_id = a.id), 0)
         + COALESCE((SELECT SUM(tri.amount_cents)
                     FROM transfers tri WHERE tri.to_account_id = a.id), 0)";

    /** @return array<int, array<string, mixed>> */
    public static function listAccounts(int $uid): array
    {
        $rows = DB::all(
            "SELECT a.id, a.name, a.type, a.color, a.image,
                    a.due_day AS dueDay, a.due_day2 AS dueDay2,
                    a.credit_limit_cents AS creditLimitCents, a.statement_day AS statementDay,
                    a.interest_rate_bp AS interestRateBp,
                    a.opening_balance_cents AS openingBalanceCents,
                    " . self::BALANCE_SQL . " AS balanceCents,
                    a.archived_at AS archivedAt,
                    (SELECT COUNT(*) FROM transactions tc WHERE tc.account_id = a.id) AS txCount,
                    (SELECT COUNT(*) FROM transfers trc
                     WHERE trc.from_account_id = a.id OR trc.to_account_id = a.id) AS transferCount
             FROM accounts a
             WHERE a.user_id = ?
             ORDER BY CASE a.type WHEN 'debit' THEN 0 WHEN 'credit' THEN 1 ELSE 2 END, LOWER(a.name)",
            [$uid]
        );
        return array_map(static fn(array $r): array => [
            'id' => (int)$r['id'],
            'name' => (string)$r['name'],
            'type' => (string)$r['type'],
            'color' => (string)$r['color'],
            'image' => $r['image'] === null ? null : (string)$r['image'],
            'dueDay' => $r['dueDay'] === null ? null : (int)$r['dueDay'],
            'dueDay2' => $r['dueDay2'] === null ? null : (int)$r['dueDay2'],
            'creditLimitCents' => $r['creditLimitCents'] === null ? null : (int)$r['creditLimitCents'],
            'statementDay' => $r['statementDay'] === null ? null : (int)$r['statementDay'],
            'interestRateBp' => $r['interestRateBp'] === null ? null : (int)$r['interestRateBp'],
            'openingBalanceCents' => (int)$r['openingBalanceCents'],
            'balanceCents' => (int)$r['balanceCents'],
            'archivedAt' => $r['archivedAt'] === null ? null : (string)$r['archivedAt'],
            'txCount' => (int)$r['txCount'],
            'transferCount' => (int)$r['transferCount'],
        ], $rows);
    }

    /**
     * The opening balance field is entered as a positive magnitude; the sign is
     * derived from the account type so users never type a minus and the stored
     * value is always correctly signed:
     *   debit  → +magnitude (an asset)
     *   credit → −magnitude (money owed)
     *   loan   → −magnitude (money borrowed)
     * abs() makes this robust even if a signed value is sent.
     */
    private static function signedOpening(string $type, mixed $raw): int
    {
        $magnitude = abs(Validate::signedCents($raw ?? 0));
        return $type === 'debit' ? $magnitude : -$magnitude;
    }

    /**
     * Due days track monthly payment cycles — meaningless on a debit account.
     * Accepts up to two days (twice-a-month plans, e.g. 15th + 30th) and
     * normalizes: dedupes, sorts, and promotes a lone second day, so due_day
     * is always the earlier/only day and due_day2 only exists alongside it.
     *
     * @return array{0: ?int, 1: ?int} [due_day, due_day2]
     */
    private static function dueDaysFor(string $type, mixed $raw, mixed $raw2): array
    {
        $days = array_values(array_unique(array_filter(
            [Validate::dueDayOrNull($raw), Validate::dueDayOrNull($raw2)],
            static fn(?int $d): bool => $d !== null
        )));
        sort($days);
        if ($days !== [] && $type === 'debit') {
            throw new ApiError('Due day only applies to credit and loan accounts', 422);
        }
        return [$days[0] ?? null, $days[1] ?? null];
    }

    /**
     * The optional card/loan details, validated for the account type:
     *   credit limit + statement closing day — credit cards only
     *   yearly interest rate (basis points)  — credit cards and loans
     * A key that's absent from the body keeps $current's value, so a client
     * that doesn't know a field can't wipe it; null clears it.
     *
     * @param array<string, mixed> $b request body
     * @param array<string, mixed> $current column => value of the row being updated ([] when creating)
     * @return array{credit_limit_cents: ?int, statement_day: ?int, interest_rate_bp: ?int}
     */
    private static function accountTermsFor(string $type, array $b, array $current): array
    {
        $pick = static fn(string $key, string $col): mixed
            => array_key_exists($key, $b) ? $b[$key] : ($current[$col] ?? null);
        $limit = Validate::amountCentsOrNull($pick('creditLimitCents', 'credit_limit_cents'));
        $statementDay = Validate::statementDayOrNull($pick('statementDay', 'statement_day'));
        $rate = Validate::interestRateBpOrNull($pick('interestRateBp', 'interest_rate_bp'));
        if ($type !== 'credit' && ($limit !== null || $statementDay !== null)) {
            throw new ApiError('A credit limit and statement day only apply to credit cards', 422);
        }
        if ($type === 'debit' && $rate !== null) {
            throw new ApiError('An interest rate only applies to credit and loan accounts', 422);
        }
        return ['credit_limit_cents' => $limit, 'statement_day' => $statementDay, 'interest_rate_bp' => $rate];
    }

    /**
     * @param array<string, mixed> $b request body
     * @return array<string, mixed>
     */
    public static function createAccount(int $uid, array $b): array
    {
        $name = Validate::name($b['name'] ?? null);
        $type = Validate::accountType($b['type'] ?? null);
        $color = Validate::color($b['color'] ?? null);
        $image = Validate::accountImage($b['image'] ?? null);
        [$dueDay, $dueDay2] = self::dueDaysFor($type, $b['dueDay'] ?? null, $b['dueDay2'] ?? null);
        $terms = self::accountTermsFor($type, $b, []);
        $opening = self::signedOpening($type, $b['openingBalanceCents'] ?? 0);
        $id = DB::insert(
            'INSERT INTO accounts (user_id, name, type, color, image, due_day, due_day2,
                                   credit_limit_cents, statement_day, interest_rate_bp, opening_balance_cents)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $uid, $name, $type, $color, $image, $dueDay, $dueDay2,
                $terms['credit_limit_cents'], $terms['statement_day'], $terms['interest_rate_bp'], $opening,
            ]
        );
        return [
            'id' => $id,
            'name' => $name,
            'type' => $type,
            'color' => $color,
            'image' => $image,
            'dueDay' => $dueDay,
            'dueDay2' => $dueDay2,
            'creditLimitCents' => $terms['credit_limit_cents'],
            'statementDay' => $terms['statement_day'],
            'interestRateBp' => $terms['interest_rate_bp'],
            'openingBalanceCents' => $opening,
            'balanceCents' => $opening,
            'archivedAt' => null,
            'txCount' => 0,
            'transferCount' => 0,
        ];
    }

    /**
     * Type is immutable after creation (changing it would re-interpret history).
     * @param array<string, mixed> $b request body
     */
    public static function updateAccount(int $uid, int $id, array $b): void
    {
        $name = Validate::name($b['name'] ?? null);
        $color = Validate::color($b['color'] ?? null);
        $image = Validate::accountImage($b['image'] ?? null);
        // Sign the opening balance using the account's existing (immutable) type.
        $existing = DB::one(
            'SELECT type, credit_limit_cents, statement_day, interest_rate_bp FROM accounts WHERE id = ? AND user_id = ?',
            [$id, $uid]
        );
        if ($existing === null) {
            throw new ApiError('Account not found', 404);
        }
        $type = (string)$existing['type'];
        [$dueDay, $dueDay2] = self::dueDaysFor($type, $b['dueDay'] ?? null, $b['dueDay2'] ?? null);
        $terms = self::accountTermsFor($type, $b, [
            'credit_limit_cents' => $existing['credit_limit_cents'] === null ? null : (int)$existing['credit_limit_cents'],
            'statement_day' => $existing['statement_day'] === null ? null : (int)$existing['statement_day'],
            'interest_rate_bp' => $existing['interest_rate_bp'] === null ? null : (int)$existing['interest_rate_bp'],
        ]);
        $opening = self::signedOpening($type, $b['openingBalanceCents'] ?? 0);
        DB::exec(
            'UPDATE accounts SET name = ?, color = ?, image = ?, due_day = ?, due_day2 = ?,
                                 credit_limit_cents = ?, statement_day = ?, interest_rate_bp = ?, opening_balance_cents = ?
             WHERE id = ? AND user_id = ?',
            [
                $name, $color, $image, $dueDay, $dueDay2,
                $terms['credit_limit_cents'], $terms['statement_day'], $terms['interest_rate_bp'], $opening, $id, $uid,
            ]
        );
    }

    public static function deleteAccount(int $uid, int $id): void
    {
        // FK actions: transactions.account_id -> NULL; transfers keep their rows
        // with the deleted side NULLed, so the other account's history stays intact.
        $count = DB::exec('DELETE FROM accounts WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($count === 0) {
            throw new ApiError('Account not found', 404);
        }
    }

    /**
     * Archive a settled account: hidden from the account lists and pickers,
     * its history untouched (unlike delete). Only at a balance of exactly 0,
     * so no money or debt is ever hidden, and not while a subscription still
     * charges it. Schedule items planning payments into it (a loan's
     * installments, a savings goal, a payday's deposit) are paused, or the
     * planner and reminders would keep showing a settled loan as due.
     * Archiving an archived account changes nothing.
     *
     * @return array{archivedAt: string, pausedItems: list<string>}
     */
    public static function archiveAccount(int $uid, int $id): array
    {
        $a = DB::one(
            'SELECT a.archived_at AS archivedAt, ' . self::BALANCE_SQL . ' AS balanceCents
             FROM accounts a WHERE a.id = ? AND a.user_id = ?',
            [$id, $uid]
        );
        if ($a === null) {
            throw new ApiError('Account not found', 404);
        }
        if ($a['archivedAt'] !== null) {
            return ['archivedAt' => (string)$a['archivedAt'], 'pausedItems' => []];
        }
        if ((int)$a['balanceCents'] !== 0) {
            throw new ApiError('Only a settled account can be archived — this one still has a balance.', 422);
        }
        $subs = array_column(
            DB::all('SELECT name FROM subscriptions WHERE user_id = ? AND account_id = ? AND active = 1 ORDER BY name', [$uid, $id]),
            'name'
        );
        if ($subs !== []) {
            throw new ApiError(
                implode(', ', $subs) . (count($subs) === 1 ? ' still charges' : ' still charge')
                    . ' this account. Move or pause it in Subscriptions first.',
                422
            );
        }

        $archivedAt = date('Y-m-d H:i:s');
        $pdo = DB::pdo();
        $pdo->beginTransaction();
        try {
            $paused = array_column(
                DB::all('SELECT name FROM schedule_items WHERE user_id = ? AND account_id = ? AND active = 1 ORDER BY name', [$uid, $id]),
                'name'
            );
            DB::exec('UPDATE schedule_items SET active = 0 WHERE user_id = ? AND account_id = ? AND active = 1', [$uid, $id]);
            DB::exec('UPDATE accounts SET archived_at = ? WHERE id = ? AND user_id = ?', [$archivedAt, $id, $uid]);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        return ['archivedAt' => $archivedAt, 'pausedItems' => array_map('strval', $paused)];
    }

    /** Back on the account lists and pickers. Paused schedule items stay paused. */
    public static function restoreAccount(int $uid, int $id): void
    {
        if (DB::one('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [$id, $uid]) === null) {
            throw new ApiError('Account not found', 404);
        }
        DB::exec('UPDATE accounts SET archived_at = NULL WHERE id = ? AND user_id = ?', [$id, $uid]);
    }

    /**
     * New activity on an archived account restores it — borrowing from a
     * settled loan again, say. Called after every new transaction or transfer
     * (Schedule payments and subscription charges included); edits of old rows
     * don't restore.
     */
    private static function restoreOnActivity(int $uid, ?int ...$accountIds): void
    {
        $ids = array_values(array_filter($accountIds, static fn(?int $id): bool => $id !== null));
        if ($ids === []) {
            return;
        }
        DB::exec(
            'UPDATE accounts SET archived_at = NULL
             WHERE user_id = ? AND archived_at IS NOT NULL AND id IN (' . implode(', ', array_fill(0, count($ids), '?')) . ')',
            [$uid, ...$ids]
        );
    }

    /** Verifies ownership; returns the account type for callers that restrict by type. */
    private static function assertAccountOwned(int $uid, int $accountId): string
    {
        $a = DB::one('SELECT type FROM accounts WHERE id = ? AND user_id = ?', [$accountId, $uid]);
        if ($a === null) {
            throw new ApiError('Invalid account', 422);
        }
        return (string)$a['type'];
    }

    // ---------- transfers ----------

    /**
     * @param array<string, mixed> $data
     * @return array{0: int, 1: ?int, 2: int, 3: int, 4: string, 5: ?string, 6: string} from, to, amount, fee, date, time, note
     */
    private static function cleanTransferInput(int $uid, array $data): array
    {
        $from = Validate::intId($data['fromAccountId'] ?? null);
        // A borrow can skip the deposit account ("just track what you owe"):
        // stored with a NULL destination so it still appears in history and
        // grows the debt (amount + fee leave the loan, land nowhere). Only
        // loan sources may omit the destination.
        $to = Validate::accountIdOrNull($data['toAccountId'] ?? null);
        if ($to !== null && $from === $to) {
            throw new ApiError('Choose two different accounts', 422);
        }
        $fromType = self::assertAccountOwned($uid, $from);
        if ($to === null) {
            if ($fromType !== 'loan') {
                throw new ApiError('Choose a destination account', 422);
            }
        } else {
            self::assertAccountOwned($uid, $to);
        }
        $amount = Validate::amountCents($data['amountCents'] ?? null);
        $fee = Validate::feeCents($data['feeCents'] ?? null);
        $date = Validate::date($data['date'] ?? null);
        $time = Validate::timeHmOrNull($data['time'] ?? null);
        $note = Validate::note($data['note'] ?? '');
        return [$from, $to, $amount, $fee, $date, $time, $note];
    }

    /** @return array<int, array<string, mixed>> */
    public static function listTransfers(int $uid, mixed $month): array
    {
        $where = ['tr.user_id = ?'];
        $params = [$uid];
        if (is_string($month) && $month !== '') {
            $where[] = 'SUBSTR(tr.date, 1, 7) = ?';
            $params[] = Validate::month($month);
        }
        $rows = DB::all(
            // Same NULL-last-within-a-day ordering as listTransactions.
            'SELECT tr.id, tr.from_account_id AS fromAccountId, tr.to_account_id AS toAccountId,
                    tr.amount_cents AS amountCents, tr.fee_cents AS feeCents, tr.date, tr.time, tr.note,
                    fa.name AS fromName, fa.color AS fromColor,
                    ta.name AS toName, ta.color AS toColor
             FROM transfers tr
             LEFT JOIN accounts fa ON fa.id = tr.from_account_id
             LEFT JOIN accounts ta ON ta.id = tr.to_account_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY tr.date DESC, tr.time DESC, tr.id DESC
             LIMIT 500',
            $params
        );
        return array_map([self::class, 'castTransfer'], $rows);
    }

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function castTransfer(array $r): array
    {
        return [
            'id' => (int)$r['id'],
            'fromAccountId' => $r['fromAccountId'] === null ? null : (int)$r['fromAccountId'],
            'toAccountId' => $r['toAccountId'] === null ? null : (int)$r['toAccountId'],
            'amountCents' => (int)$r['amountCents'],
            'feeCents' => (int)$r['feeCents'],
            'date' => (string)$r['date'],
            'time' => $r['time'] === null ? null : (string)$r['time'],
            'note' => (string)$r['note'],
            'fromName' => $r['fromName'] === null ? null : (string)$r['fromName'],
            'fromColor' => $r['fromColor'] === null ? null : (string)$r['fromColor'],
            'toName' => $r['toName'] === null ? null : (string)$r['toName'],
            'toColor' => $r['toColor'] === null ? null : (string)$r['toColor'],
        ];
    }

    /**
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function createTransfer(int $uid, array $data): array
    {
        [$from, $to, $amount, $fee, $date, $time, $note] = self::cleanTransferInput($uid, $data);
        $id = DB::insert(
            'INSERT INTO transfers (user_id, from_account_id, to_account_id, amount_cents, fee_cents, date, time, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$uid, $from, $to, $amount, $fee, $date, $time, $note]
        );
        self::restoreOnActivity($uid, $from, $to);
        $row = DB::one(
            'SELECT tr.id, tr.from_account_id AS fromAccountId, tr.to_account_id AS toAccountId,
                    tr.amount_cents AS amountCents, tr.fee_cents AS feeCents, tr.date, tr.time, tr.note,
                    fa.name AS fromName, fa.color AS fromColor,
                    ta.name AS toName, ta.color AS toColor
             FROM transfers tr
             LEFT JOIN accounts fa ON fa.id = tr.from_account_id
             LEFT JOIN accounts ta ON ta.id = tr.to_account_id
             WHERE tr.id = ? AND tr.user_id = ?',
            [$id, $uid]
        );
        assert($row !== null);
        return self::castTransfer($row);
    }

    /** @param array<string, mixed> $data */
    public static function updateTransfer(int $uid, int $id, array $data): void
    {
        [$from, $to, $amount, $fee, $date, $time, $note] = self::cleanTransferInput($uid, $data);
        if (DB::one('SELECT id FROM transfers WHERE id = ? AND user_id = ?', [$id, $uid]) === null) {
            throw new ApiError('Transfer not found', 404);
        }
        DB::exec(
            'UPDATE transfers SET from_account_id = ?, to_account_id = ?, amount_cents = ?, fee_cents = ?, date = ?, time = ?, note = ?
             WHERE id = ? AND user_id = ?',
            [$from, $to, $amount, $fee, $date, $time, $note, $id, $uid]
        );
    }

    public static function deleteTransfer(int $uid, int $id): void
    {
        $count = DB::exec('DELETE FROM transfers WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($count === 0) {
            throw new ApiError('Transfer not found', 404);
        }
    }

    // ---------- budgets ----------

    /**
     * Inclusive [start, end] date range of the period of `cadence` that
     * contains the server's "today". Weeks are Sunday-start, matching the
     * frontend's periodOf('week'). Used to scope each recurring budget's
     * "spent so far this period".
     * @return array{0: string, 1: string}
     */
    private static function currentPeriodRange(string $cadence): array
    {
        if ($cadence === 'week') {
            $dow = (int)date('w'); // 0 = Sunday .. 6 = Saturday
            $start = date('Y-m-d', strtotime("-{$dow} days"));
            return [$start, date('Y-m-d', strtotime($start . ' +6 days'))];
        }
        if ($cadence === 'year') {
            return [date('Y-01-01'), date('Y-12-31')];
        }
        return [date('Y-m-01'), date('Y-m-t')]; // month
    }

    /** First day of the period of `cadence` that contains $date (weeks start on Sunday). */
    private static function periodStart(string $cadence, string $date): string
    {
        $ts = (int)strtotime($date . ' 12:00:00');
        if ($cadence === 'week') {
            return date('Y-m-d', (int)strtotime('-' . (int)date('w', $ts) . ' days', $ts));
        }
        return $cadence === 'year' ? date('Y-01-01', $ts) : date('Y-m-01', $ts);
    }

    /** Whole periods of `cadence` from the period starting $fromStart to the one holding $date (0 = the same). */
    private static function periodIndex(string $cadence, string $fromStart, string $date): int
    {
        if ($cadence === 'week') {
            // Noon to noon, so a daylight-saving shift can't drop a day.
            $days = (int)round((strtotime($date . ' 12:00:00') - strtotime($fromStart . ' 12:00:00')) / 86400);
            return (int)floor($days / 7);
        }
        [$y0, $m0] = array_map('intval', explode('-', $fromStart));
        [$y, $m] = array_map('intval', explode('-', $date));
        return $cadence === 'year' ? $y - $y0 : ($y - $y0) * 12 + ($m - $m0);
    }

    /**
     * What a rollover budget brings into the current period. Each completed
     * period since $from leaves carry + amount − spent, never below zero:
     * unused money rolls forward, and an overspent period uses up the carry
     * without putting the next one in debt. Worked out from the ledger on
     * every read, at the budget's current amount, so editing an old expense
     * is reflected and nothing is stored that could drift.
     */
    private static function rolloverCarry(int $uid, int $categoryId, string $cadence, int $amount, string $from, string $currentStart): int
    {
        $periods = self::periodIndex($cadence, $from, $currentStart);
        if ($periods <= 0) {
            return 0;
        }
        $spent = array_fill(0, $periods, 0);
        $rows = DB::all(
            "SELECT date, SUM(amount_cents) AS total FROM transactions
             WHERE user_id = ? AND category_id = ? AND type = 'expense' AND date >= ? AND date < ?
             GROUP BY date",
            [$uid, $categoryId, $from, $currentStart]
        );
        foreach ($rows as $r) {
            $i = self::periodIndex($cadence, $from, (string)$r['date']);
            if ($i >= 0 && $i < $periods) {
                $spent[$i] += (int)$r['total'];
            }
        }
        $carry = 0;
        foreach ($spent as $s) {
            $carry = max(0, $carry + $amount - $s);
        }
        return $carry;
    }

    /**
     * One row per expense category (budget may be unset = amount 0). `spentCents`
     * is the category's expense total within the current period of that row's
     * cadence, so the progress shown is against the right window. A rollover
     * budget also carries `carryCents` — what earlier periods left unused —
     * so this period's limit is amountCents + carryCents.
     * @return array<int, array<string, mixed>>
     */
    public static function listBudgets(int $uid): array
    {
        [$wStart, $wEnd] = self::currentPeriodRange('week');
        [$mStart, $mEnd] = self::currentPeriodRange('month');
        [$yStart, $yEnd] = self::currentPeriodRange('year');

        // Correlated subquery picks the spend window by the row's cadence
        // (falling back to 'month' for as-yet-unbudgeted categories).
        $rows = DB::all(
            "SELECT COALESCE(b.id, 0) AS id,
                    c.id AS categoryId,
                    COALESCE(b.cadence, 'month') AS cadence,
                    COALESCE(b.amount_cents, 0) AS amountCents,
                    COALESCE(b.rollover, 0) AS rollover,
                    b.rollover_from AS rolloverFrom,
                    c.name AS categoryName,
                    c.color AS categoryColor,
                    COALESCE((
                        SELECT SUM(t.amount_cents) FROM transactions t
                        WHERE t.category_id = c.id AND t.type = 'expense'
                          AND t.date >= CASE COALESCE(b.cadence, 'month')
                                          WHEN 'week' THEN ? WHEN 'year' THEN ? ELSE ? END
                          AND t.date <= CASE COALESCE(b.cadence, 'month')
                                          WHEN 'week' THEN ? WHEN 'year' THEN ? ELSE ? END
                    ), 0) AS spentCents
             FROM categories c
             LEFT JOIN budgets b ON b.category_id = c.id
             WHERE c.type = 'expense' AND c.user_id = ?
             ORDER BY LOWER(c.name)",
            [$wStart, $yStart, $mStart, $wEnd, $yEnd, $mEnd, $uid]
        );
        $starts = ['week' => $wStart, 'month' => $mStart, 'year' => $yStart];
        return array_map(static function (array $r) use ($uid, $starts): array {
            $cadence = (string)$r['cadence'];
            $amount = (int)$r['amountCents'];
            $rollover = (int)$r['rollover'] === 1 && $amount > 0;
            return [
                'id' => (int)$r['id'],
                'categoryId' => (int)$r['categoryId'],
                'cadence' => $cadence,
                'amountCents' => $amount,
                'rollover' => $rollover,
                'carryCents' => $rollover && $r['rolloverFrom'] !== null
                    ? self::rolloverCarry($uid, (int)$r['categoryId'], $cadence, $amount, (string)$r['rolloverFrom'], $starts[$cadence])
                    : 0,
                'categoryName' => (string)$r['categoryName'],
                'categoryColor' => (string)$r['categoryColor'],
                'spentCents' => (int)$r['spentCents'],
            ];
        }, $rows);
    }

    /**
     * Sets a category's budget (amount 0 removes it).
     *
     * Rollover: `$rollover` absent (null) keeps what the budget has, off for
     * a new one. Carry is counted from rollover_from, the first day of a
     * period: the current one when rollover is switched on or the cadence
     * changes (weeks and months don't line up), unchanged while it stays on,
     * or the period holding `$rolloverFrom` when the client names a date (up
     * to 5 years back, never ahead).
     */
    public static function upsertBudget(int $uid, mixed $categoryId, mixed $cadence, mixed $amountCents, mixed $rollover = null, mixed $rolloverFrom = null): void
    {
        $categoryId = Validate::intId($categoryId);
        $cadence = Validate::cadence($cadence);
        $amount = Validate::amountCents($amountCents, true);
        self::assertCategoryOwned($uid, $categoryId, 'expense');

        if ($amount === 0) {
            DB::exec(
                'DELETE FROM budgets WHERE category_id = ? AND user_id = ?',
                [$categoryId, $uid]
            );
            return;
        }

        $existing = DB::one(
            'SELECT cadence, rollover, rollover_from FROM budgets WHERE category_id = ? AND user_id = ?',
            [$categoryId, $uid]
        );
        $wasOn = $existing !== null && (int)$existing['rollover'] === 1;
        $on = $rollover === null ? $wasOn : Validate::boolean($rollover, 'Rollover');
        $from = null;
        if ($on) {
            $requested = Validate::dateOrNull($rolloverFrom);
            if ($requested !== null) {
                if ($requested > date('Y-m-d') || $requested < date('Y-m-d', (int)strtotime('-5 years'))) {
                    throw new ApiError('Rollover can start up to 5 years back, not in the future', 422);
                }
                $from = self::periodStart($cadence, $requested);
            } elseif ($wasOn && $existing['rollover_from'] !== null && (string)$existing['cadence'] === $cadence) {
                $from = (string)$existing['rollover_from'];
            } else {
                $from = self::currentPeriodRange($cadence)[0];
            }
        }

        $params = [$uid, $categoryId, $cadence, $amount, $on ? 1 : 0, $from];
        if (DB::driver() === 'sqlite') {
            DB::exec(
                'INSERT INTO budgets (user_id, category_id, cadence, amount_cents, rollover, rollover_from) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (category_id) DO UPDATE SET cadence = excluded.cadence, amount_cents = excluded.amount_cents,
                                                        rollover = excluded.rollover, rollover_from = excluded.rollover_from',
                $params
            );
        } else {
            DB::exec(
                'INSERT INTO budgets (user_id, category_id, cadence, amount_cents, rollover, rollover_from) VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE cadence = VALUES(cadence), amount_cents = VALUES(amount_cents),
                                         rollover = VALUES(rollover), rollover_from = VALUES(rollover_from)',
                $params
            );
        }
    }

    // ---------- reports ----------

    /**
     * Convert a YYYY-MM month into an inclusive [from, to] date range, so the
     * legacy ?month= report param keeps working alongside ?from=&to=.
     * @return array{0: string, 1: string}
     */
    public static function monthRange(mixed $month): array
    {
        $m = Validate::month($month);
        return [$m . '-01', date('Y-m-t', strtotime($m . '-01'))];
    }

    /** @return array<string, mixed> */
    public static function summary(int $uid, mixed $from, mixed $to): array
    {
        $from = Validate::date($from);
        $to = Validate::date($to);
        $rows = DB::all(
            'SELECT type, SUM(amount_cents) AS total FROM transactions
             WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY type',
            [$uid, $from, $to]
        );
        $out = ['month' => substr($from, 0, 7), 'incomeCents' => 0, 'expenseCents' => 0];
        foreach ($rows as $r) {
            if ($r['type'] === 'income') {
                $out['incomeCents'] = (int)$r['total'];
            }
            if ($r['type'] === 'expense') {
                $out['expenseCents'] = (int)$r['total'];
            }
        }
        return $out;
    }

    /** @return array<int, array<string, mixed>> */
    public static function trend(int $uid, mixed $endMonth, mixed $count): array
    {
        $endMonth = Validate::month($endMonth);
        $n = is_numeric($count) ? (int)$count : 6;
        $n = max(1, min(24, $n));

        [$y, $m] = array_map('intval', explode('-', $endMonth));
        $months = [];
        for ($i = $n - 1; $i >= 0; $i--) {
            $mm = $m - $i;
            $yy = $y;
            while ($mm <= 0) {
                $mm += 12;
                $yy--;
            }
            $months[] = sprintf('%04d-%02d', $yy, $mm);
        }

        $placeholders = implode(',', array_fill(0, count($months), '?'));
        $rows = DB::all(
            "SELECT SUBSTR(date, 1, 7) AS month, type, SUM(amount_cents) AS total
             FROM transactions
             WHERE user_id = ? AND SUBSTR(date, 1, 7) IN ($placeholders)
             GROUP BY SUBSTR(date, 1, 7), type",
            array_merge([$uid], $months)
        );

        $map = [];
        foreach ($months as $mo) {
            $map[$mo] = ['month' => $mo, 'incomeCents' => 0, 'expenseCents' => 0];
        }
        foreach ($rows as $r) {
            $mo = (string)$r['month'];
            if (!isset($map[$mo])) {
                continue;
            }
            if ($r['type'] === 'income') {
                $map[$mo]['incomeCents'] = (int)$r['total'];
            }
            if ($r['type'] === 'expense') {
                $map[$mo]['expenseCents'] = (int)$r['total'];
            }
        }
        return array_values($map);
    }

    /** @return array<int, array<string, mixed>> */
    public static function breakdown(int $uid, mixed $from, mixed $to, mixed $type): array
    {
        $from = Validate::date($from);
        $to = Validate::date($to);
        $type = Validate::type($type);
        $rows = DB::all(
            "SELECT t.category_id AS categoryId,
                    COALESCE(c.name, 'Uncategorized') AS name,
                    COALESCE(c.color, '#64748b') AS color,
                    SUM(t.amount_cents) AS totalCents
             FROM transactions t
             LEFT JOIN categories c ON c.id = t.category_id
             WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? AND t.type = ?
             GROUP BY t.category_id, c.name, c.color
             ORDER BY totalCents DESC",
            [$uid, $from, $to, $type]
        );
        return array_map(static fn(array $r): array => [
            'categoryId' => $r['categoryId'] === null ? null : (int)$r['categoryId'],
            'name' => (string)$r['name'],
            'color' => (string)$r['color'],
            'totalCents' => (int)$r['totalCents'],
        ], $rows);
    }

    /**
     * Distinct calendar years (ascending) that have at least one transaction,
     * so the UI can offer a year picker limited to years with actual activity.
     * @return array<int, int>
     */
    public static function transactionYears(int $uid): array
    {
        $rows = DB::all(
            'SELECT DISTINCT SUBSTR(date, 1, 4) AS y FROM transactions WHERE user_id = ? ORDER BY y',
            [$uid]
        );
        return array_map(static fn(array $r): int => (int)$r['y'], $rows);
    }

    /**
     * Net worth at the end of each of the last $months months, oldest first
     * (the last point is "now"). An account's balance at a month end is its
     * opening balance plus everything dated up to then; assets are the
     * positive balances and liabilities the negative ones — the Accounts
     * page's Net Worth card, back in time.
     *
     * An account counts from the month it was added, or from its first dated
     * entry when that's earlier: before then its balance isn't known, so it
     * isn't guessed. Months before the first account are left out. The last
     * point takes every entry (future-dated ones too), so it always equals
     * the card.
     *
     * @return array<int, array{month: string, assetsCents: int, liabilitiesCents: int, netCents: int}>
     */
    public static function netWorthHistory(int $uid, mixed $months): array
    {
        $n = is_numeric($months) ? (int)$months : 12;
        $n = max(1, min(60, $n));

        $accounts = DB::all(
            'SELECT id, opening_balance_cents AS opening, created_at AS createdAt FROM accounts WHERE user_id = ?',
            [$uid]
        );
        if ($accounts === []) {
            return [];
        }

        // Signed change per account per month, from the three places money moves.
        /** @var array<int, array<string, int>> $deltas */
        $deltas = [];
        $sources = [
            "SELECT account_id AS accountId, SUBSTR(date, 1, 7) AS month,
                    SUM(CASE WHEN type = 'income' THEN amount_cents ELSE -amount_cents END) AS delta
             FROM transactions WHERE user_id = ? AND account_id IS NOT NULL
             GROUP BY account_id, SUBSTR(date, 1, 7)",
            'SELECT from_account_id AS accountId, SUBSTR(date, 1, 7) AS month,
                    -SUM(amount_cents + fee_cents) AS delta
             FROM transfers WHERE user_id = ? AND from_account_id IS NOT NULL
             GROUP BY from_account_id, SUBSTR(date, 1, 7)',
            'SELECT to_account_id AS accountId, SUBSTR(date, 1, 7) AS month,
                    SUM(amount_cents) AS delta
             FROM transfers WHERE user_id = ? AND to_account_id IS NOT NULL
             GROUP BY to_account_id, SUBSTR(date, 1, 7)',
        ];
        foreach ($sources as $sql) {
            foreach (DB::all($sql, [$uid]) as $r) {
                $id = (int)$r['accountId'];
                $month = (string)$r['month'];
                $deltas[$id][$month] = ($deltas[$id][$month] ?? 0) + (int)$r['delta'];
            }
        }

        $y = (int)date('Y');
        $m = (int)date('n');
        $monthList = [];
        for ($i = $n - 1; $i >= 0; $i--) {
            $monthList[] = date('Y-m', (int)mktime(12, 0, 0, $m - $i, 1, $y));
        }
        $current = $monthList[count($monthList) - 1];

        $points = [];
        foreach ($monthList as $month) {
            $points[$month] = ['month' => $month, 'assetsCents' => 0, 'liabilitiesCents' => 0, 'netCents' => 0];
        }
        $earliest = null;
        foreach ($accounts as $a) {
            $mine = $deltas[(int)$a['id']] ?? [];
            ksort($mine);
            $start = substr((string)$a['createdAt'], 0, 7);
            $firstEntry = array_key_first($mine);
            if ($firstEntry !== null && $firstEntry < $start) {
                $start = $firstEntry;
            }
            // An account whose only entries are dated ahead still exists today.
            $start = min($start, $current);
            if ($earliest === null || $start < $earliest) {
                $earliest = $start;
            }
            $opening = (int)$a['opening'];
            foreach ($monthList as $month) {
                if ($month < $start) {
                    continue;
                }
                $balance = $opening;
                foreach ($mine as $deltaMonth => $delta) {
                    if ($deltaMonth <= $month || $month === $current) {
                        $balance += $delta;
                    }
                }
                if ($balance > 0) {
                    $points[$month]['assetsCents'] += $balance;
                } else {
                    $points[$month]['liabilitiesCents'] -= $balance;
                }
            }
        }

        $out = [];
        foreach ($points as $month => $p) {
            if ($month < $earliest) {
                continue; // nothing was tracked yet
            }
            $p['netCents'] = $p['assetsCents'] - $p['liabilitiesCents'];
            $out[] = $p;
        }
        return $out;
    }

    // ---------- subscriptions ----------

    private const SUB_SELECT =
        'SELECT s.id, s.account_id AS accountId, s.category_id AS categoryId, s.name,
                s.amount_cents AS amountCents, s.cycle, s.bill_day AS billDay,
                s.interval_days AS intervalDays, s.next_date AS nextDate, s.active,
                a.name AS accountName, a.color AS accountColor,
                c.name AS categoryName, c.color AS categoryColor
         FROM subscriptions s
         LEFT JOIN accounts a ON a.id = s.account_id
         LEFT JOIN categories c ON c.id = s.category_id';

    /** @return array<int, array<string, mixed>> */
    public static function listSubscriptions(int $uid): array
    {
        $rows = DB::all(
            self::SUB_SELECT . ' WHERE s.user_id = ? ORDER BY s.next_date ASC, s.id ASC',
            [$uid]
        );
        return array_map([self::class, 'castSubscription'], $rows);
    }

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function castSubscription(array $r): array
    {
        return [
            'id' => (int)$r['id'],
            'name' => (string)$r['name'],
            'amountCents' => (int)$r['amountCents'],
            'accountId' => $r['accountId'] === null ? null : (int)$r['accountId'],
            'accountName' => $r['accountName'] === null ? null : (string)$r['accountName'],
            'accountColor' => $r['accountColor'] === null ? null : (string)$r['accountColor'],
            'categoryId' => $r['categoryId'] === null ? null : (int)$r['categoryId'],
            'categoryName' => $r['categoryName'] === null ? null : (string)$r['categoryName'],
            'categoryColor' => $r['categoryColor'] === null ? null : (string)$r['categoryColor'],
            'cycle' => (string)$r['cycle'],
            'billDay' => $r['billDay'] === null ? null : (int)$r['billDay'],
            'intervalDays' => $r['intervalDays'] === null ? null : (int)$r['intervalDays'],
            'nextDate' => (string)$r['nextDate'],
            'active' => (int)$r['active'] === 1,
        ];
    }

    /**
     * @param array<string, mixed> $data
     * @return array{0: string, 1: int, 2: int, 3: ?int, 4: string, 5: ?int, 6: ?int, 7: string, 8: bool}
     *         name, amount, accountId, categoryId, cycle, billDay, intervalDays, nextDate, active
     */
    private static function cleanSubInput(int $uid, array $data): array
    {
        $name = Validate::name($data['name'] ?? null);
        $amount = Validate::amountCents($data['amountCents'] ?? null);
        $accountId = Validate::intId($data['accountId'] ?? null);
        self::assertChargeableAccount($uid, $accountId);
        $categoryId = Validate::categoryIdOrNull($data['categoryId'] ?? null);
        if ($categoryId !== null) {
            // Charges are expenses, so only expense categories make sense.
            self::assertCategoryOwned($uid, $categoryId, 'expense');
        }
        $cycle = Validate::subCycle($data['cycle'] ?? null);
        $nextDate = Validate::date($data['nextDate'] ?? null);
        // Monthly/yearly: the chosen next-charge date's day-of-month is the
        // anchor every later cycle re-lands on. Storing it separately keeps a
        // "31st" subscription on the 31st after clamping through February
        // (and a Feb-29 yearly one on the 29th across non-leap years).
        $billDay = $cycle === 'interval' ? null : (int)substr($nextDate, 8, 2);
        $intervalDays = $cycle === 'interval' ? Validate::intervalDays($data['intervalDays'] ?? null) : null;
        $active = !array_key_exists('active', $data) || (bool)$data['active'];
        return [$name, $amount, $accountId, $categoryId, $cycle, $billDay, $intervalDays, $nextDate, $active];
    }

    /** Loans can't be charged — they have no spendable balance to deduct. */
    private static function assertChargeableAccount(int $uid, int $accountId): void
    {
        $a = DB::one('SELECT type FROM accounts WHERE id = ? AND user_id = ?', [$accountId, $uid]);
        if ($a === null) {
            throw new ApiError('Invalid account', 422);
        }
        if ((string)$a['type'] === 'loan') {
            throw new ApiError('Subscriptions must charge a debit or credit account', 422);
        }
    }

    /**
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function createSubscription(int $uid, array $data): array
    {
        [$name, $amount, $accountId, $categoryId, $cycle, $billDay, $intervalDays, $nextDate, $active] =
            self::cleanSubInput($uid, $data);
        // Past first-charge dates are allowed (catch-up backfills the missed
        // cycles as dated charges), but bounded: an ancient date + short
        // interval would schedule hundreds of thousands of catch-up writes
        // into the per-request processing hook.
        if ($nextDate < date('Y-m-d', strtotime('-2 years'))) {
            throw new ApiError('Next charge date is too far in the past', 422);
        }
        $id = DB::insert(
            'INSERT INTO subscriptions (user_id, account_id, category_id, name, amount_cents, cycle, bill_day, interval_days, next_date, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$uid, $accountId, $categoryId, $name, $amount, $cycle, $billDay, $intervalDays, $nextDate, $active ? 1 : 0]
        );
        $row = DB::one(self::SUB_SELECT . ' WHERE s.id = ? AND s.user_id = ?', [$id, $uid]);
        assert($row !== null);
        return self::castSubscription($row);
    }

    /** @param array<string, mixed> $data */
    public static function updateSubscription(int $uid, int $id, array $data): void
    {
        [$name, $amount, $accountId, $categoryId, $cycle, $billDay, $intervalDays, $nextDate, $active] =
            self::cleanSubInput($uid, $data);
        $existing = DB::one(
            'SELECT cycle, bill_day, next_date, charged_through FROM subscriptions WHERE id = ? AND user_id = ?',
            [$id, $uid]
        );
        if ($existing === null) {
            throw new ApiError('Subscription not found', 404);
        }
        // Editing without touching the date must not lose the day anchor: a
        // "31st" monthly sub whose next_date currently reads Feb 28 (clamped)
        // would otherwise get its bill_day re-derived as 28 — same for a
        // Feb-29 yearly sub showing Feb 28 in a non-leap year.
        if (
            $cycle !== 'interval' && $cycle === (string)$existing['cycle']
            && $nextDate === (string)$existing['next_date'] && $existing['bill_day'] !== null
        ) {
            $billDay = (int)$existing['bill_day'];
        }
        // next_date may never re-enter charged territory. A client whose list
        // went stale (overnight tab, second device) echoes back the OLD
        // next_date after the server already charged that day — writing it
        // would make the next request charge the same cycle twice.
        $chargedThrough = $existing['charged_through'] === null ? null : (string)$existing['charged_through'];
        if ($chargedThrough !== null) {
            for ($i = 0; $nextDate <= $chargedThrough && $i < 1000; $i++) {
                $nextDate = self::advanceSubDate($nextDate, $cycle, $billDay, $intervalDays);
            }
            if ($nextDate <= $chargedThrough) {
                throw new ApiError('Next charge date is too far in the past', 422);
            }
        }
        // Re-activating (or relinking an account) with a stale next_date must
        // not back-charge the paused stretch — a Netflix paused for 4 months
        // isn't 4 charges behind. Roll forward to the first occurrence that
        // isn't in the past. (Active subs are normally already >= today here:
        // processDueSubscriptions runs before every request.)
        if ($active) {
            $today = date('Y-m-d');
            for ($i = 0; $nextDate < $today && $i < 20000; $i++) {
                $nextDate = self::advanceSubDate($nextDate, $cycle, $billDay, $intervalDays);
            }
            if ($nextDate < $today) {
                throw new ApiError('Next charge date is too far in the past', 422);
            }
        }
        DB::exec(
            'UPDATE subscriptions SET account_id = ?, category_id = ?, name = ?, amount_cents = ?, cycle = ?, bill_day = ?, interval_days = ?, next_date = ?, active = ?
             WHERE id = ? AND user_id = ?',
            [$accountId, $categoryId, $name, $amount, $cycle, $billDay, $intervalDays, $nextDate, $active ? 1 : 0, $id, $uid]
        );
    }

    public static function deleteSubscription(int $uid, int $id): void
    {
        // Past charges are ordinary transactions and stay in history.
        $count = DB::exec('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($count === 0) {
            throw new ApiError('Subscription not found', 404);
        }
    }

    /**
     * Auto-charging. For every active, account-linked subscription whose
     * next_date has arrived, insert the expense (dated the DUE date, not
     * today) and advance next_date one cycle — looping so several missed
     * cycles catch up (capped). Runs on every authenticated data request
     * (cheap indexed SELECT when nothing is due). The conditional UPDATE
     * claims each cycle atomically, so two concurrent requests can never
     * double-charge: only the request that actually advanced next_date
     * inserts the transaction.
     */
    public static function processDueSubscriptions(int $uid): void
    {
        $today = date('Y-m-d');
        $dues = DB::all(
            'SELECT id, account_id, category_id, name, amount_cents, cycle, bill_day, interval_days, next_date
             FROM subscriptions
             WHERE user_id = ? AND active = 1 AND account_id IS NOT NULL AND next_date <= ?',
            [$uid, $today]
        );
        $pdo = DB::pdo();
        foreach ($dues as $s) {
            $next = (string)$s['next_date'];
            for ($i = 0; $next <= $today && $i < 60; $i++) {
                $newNext = self::advanceSubDate(
                    $next,
                    (string)$s['cycle'],
                    $s['bill_day'] === null ? null : (int)$s['bill_day'],
                    $s['interval_days'] === null ? null : (int)$s['interval_days']
                );
                // Claim + insert are one atomic unit: a crash or a failed
                // insert (e.g. the account/category was deleted by a parallel
                // request after our SELECT) rolls the claim back, so the cycle
                // is retried cleanly on the next request instead of being
                // silently lost. Failures also must not 500 the request that
                // merely triggered processing — skip the sub and move on.
                $pdo->beginTransaction();
                try {
                    $claimed = DB::exec(
                        'UPDATE subscriptions SET next_date = ?, charged_through = ? WHERE id = ? AND next_date = ?',
                        [$newNext, $next, (int)$s['id'], $next]
                    );
                    if ($claimed === 0) {
                        $pdo->rollBack();
                        break; // another request already charged this cycle
                    }
                    DB::insert(
                        'INSERT INTO transactions (user_id, amount_cents, type, category_id, account_id, date, note)
                         VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [
                            $uid,
                            (int)$s['amount_cents'],
                            'expense',
                            $s['category_id'] === null ? null : (int)$s['category_id'],
                            (int)$s['account_id'],
                            $next,
                            (string)$s['name'] . ' (subscription)',
                        ]
                    );
                    self::restoreOnActivity($uid, (int)$s['account_id']);
                    $pdo->commit();
                } catch (Throwable) {
                    if ($pdo->inTransaction()) {
                        $pdo->rollBack();
                    }
                    break;
                }
                $next = $newNext;
            }
        }
    }

    /**
     * One billing cycle after $date. Monthly re-lands on bill_day next month,
     * yearly on the same month + bill_day next year — both clamped to the
     * target month's length (31st in short months, Feb 29 in non-leap years).
     */
    private static function advanceSubDate(string $date, string $cycle, ?int $billDay, ?int $intervalDays): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', $date));
        if ($cycle === 'interval') {
            // mktime normalizes day overflow into the following month(s).
            return date('Y-m-d', (int)mktime(12, 0, 0, $m, $d + max(1, (int)$intervalDays), $y));
        }
        if ($cycle === 'yearly') {
            $y += 1;
        } else {
            $m += 1;
            if ($m > 12) {
                $m = 1;
                $y += 1;
            }
        }
        $anchor = $billDay ?? $d;
        $lastDay = (int)date('t', (int)mktime(12, 0, 0, $m, 1, $y));
        return sprintf('%04d-%02d-%02d', $y, $m, min($anchor, $lastDay));
    }

    // ---------- payment schedule ----------

    private const SCHEDULE_SELECT =
        'SELECT id, name, kind, account_id AS accountId, subscription_id AS subscriptionId,
                category_id AS categoryId, amount_mode AS amountMode, amount_cents AS amountCents,
                match_keyword AS matchKeyword, due_day AS dueDay, week_day AS weekDay,
                funded_by AS fundedBy, weekend_shift AS weekendShift, start_date AS startDate,
                end_date AS endDate, goal_cents AS goalCents, goal_milestones AS goalMilestones,
                pay_from_account_id AS payFromAccountId, active
         FROM schedule_items';

    // Amount and paid date come from the linked ledger row, never a copy.
    private const SCHEDULE_PAYMENT_SELECT =
        'SELECT sp.id, sp.item_id AS itemId, sp.due_date AS dueDate,
                sp.transfer_id AS transferId, sp.transaction_id AS transactionId,
                COALESCE(tr.amount_cents, t.amount_cents) AS amountCents,
                COALESCE(tr.date, t.date) AS paidDate
         FROM schedule_payments sp
         LEFT JOIN transfers tr ON tr.id = sp.transfer_id
         LEFT JOIN transactions t ON t.id = sp.transaction_id';

    /**
     * Everything the Schedule page needs in one round trip:
     *   items    — paydays + planned outflows (avg3 bills carry their estimate)
     *   payments — explicit occurrence -> ledger links (last ~13 months)
     *   activity — recent ledger rows that can settle an occurrence even when
     *              they weren't paid through the Schedule: transfers INTO
     *              loan/card/savings item accounts, income into payday deposit
     *              accounts, expenses in bill categories. Linked rows appear
     *              here too; the client skips them by id so nothing counts twice.
     * @return array<string, mixed>
     */
    public static function getSchedule(int $uid): array
    {
        $items = array_map(
            static fn(array $r): array => self::castScheduleItem($uid, $r),
            DB::all(self::SCHEDULE_SELECT . ' WHERE user_id = ? ORDER BY id', [$uid])
        );
        $payments = array_map(
            [self::class, 'castSchedulePayment'],
            DB::all(
                self::SCHEDULE_PAYMENT_SELECT . ' WHERE sp.user_id = ? AND sp.due_date >= ? ORDER BY sp.due_date, sp.id',
                [$uid, date('Y-m-d', strtotime('-400 days'))]
            )
        );

        $since = date('Y-m-d', strtotime('-120 days'));
        $transfers = DB::all(
            "SELECT tr.id, tr.to_account_id AS accountId, tr.date, tr.amount_cents AS amountCents, tr.note
             FROM transfers tr
             WHERE tr.user_id = ? AND tr.date >= ? AND tr.to_account_id IN (
                 SELECT si.account_id FROM schedule_items si
                 WHERE si.user_id = ? AND si.kind IN ('loan', 'card', 'savings') AND si.account_id IS NOT NULL)
             ORDER BY tr.date, tr.id
             LIMIT 1000",
            [$uid, $since, $uid]
        );
        $txs = DB::all(
            "SELECT t.id, t.type, t.account_id AS accountId, t.category_id AS categoryId,
                    t.date, t.amount_cents AS amountCents, t.note
             FROM transactions t
             WHERE t.user_id = ? AND t.date >= ? AND (
                 (t.type = 'income' AND t.account_id IN (
                     SELECT si.account_id FROM schedule_items si
                     WHERE si.user_id = ? AND si.kind = 'income' AND si.account_id IS NOT NULL))
                 OR (t.type = 'expense' AND t.category_id IN (
                     SELECT si.category_id FROM schedule_items si
                     WHERE si.user_id = ? AND si.kind = 'bill' AND si.category_id IS NOT NULL)))
             ORDER BY t.date, t.id
             LIMIT 1000",
            [$uid, $since, $uid, $uid]
        );
        $activity = [];
        foreach ($transfers as $r) {
            $activity[] = [
                'source' => 'transfer',
                'id' => (int)$r['id'],
                'type' => 'transfer',
                'accountId' => (int)$r['accountId'],
                'categoryId' => null,
                'date' => (string)$r['date'],
                'amountCents' => (int)$r['amountCents'],
                'note' => (string)$r['note'],
            ];
        }
        foreach ($txs as $r) {
            $activity[] = [
                'source' => 'transaction',
                'id' => (int)$r['id'],
                'type' => (string)$r['type'],
                'accountId' => $r['accountId'] === null ? null : (int)$r['accountId'],
                'categoryId' => $r['categoryId'] === null ? null : (int)$r['categoryId'],
                'date' => (string)$r['date'],
                'amountCents' => (int)$r['amountCents'],
                'note' => (string)$r['note'],
            ];
        }
        return ['items' => $items, 'payments' => $payments, 'activity' => $activity];
    }

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function castScheduleItem(int $uid, array $r): array
    {
        $item = [
            'id' => (int)$r['id'],
            'name' => (string)$r['name'],
            'kind' => (string)$r['kind'],
            'accountId' => $r['accountId'] === null ? null : (int)$r['accountId'],
            'subscriptionId' => $r['subscriptionId'] === null ? null : (int)$r['subscriptionId'],
            'categoryId' => $r['categoryId'] === null ? null : (int)$r['categoryId'],
            'amountMode' => (string)$r['amountMode'],
            'amountCents' => (int)$r['amountCents'],
            'matchKeyword' => $r['matchKeyword'] === null ? null : (string)$r['matchKeyword'],
            'dueDay' => $r['dueDay'] === null ? null : (int)$r['dueDay'],
            'weekDay' => $r['weekDay'] === null ? null : (int)$r['weekDay'],
            'fundedBy' => $r['fundedBy'] === null ? null : (int)$r['fundedBy'],
            'weekendShift' => (string)$r['weekendShift'],
            'startDate' => (string)$r['startDate'],
            'endDate' => $r['endDate'] === null ? null : (string)$r['endDate'],
            'goalCents' => $r['goalCents'] === null ? null : (int)$r['goalCents'],
            'goalMilestones' => $r['goalMilestones'] === null || $r['goalMilestones'] === ''
                ? []
                : array_map('intval', explode(',', (string)$r['goalMilestones'])),
            'payFromAccountId' => $r['payFromAccountId'] === null ? null : (int)$r['payFromAccountId'],
            'active' => (int)$r['active'] === 1,
            'estimateCents' => null,
            'estimateFrom' => null,
            'estimateTo' => null,
        ];
        if ($item['kind'] === 'bill' && $item['amountMode'] === 'avg3' && $item['categoryId'] !== null) {
            // Total over the 3 complete months ÷ 3, so a bill paid late (two
            // in one month, none in the next) still averages correctly.
            [$from, $to] = self::estimateWindow();
            $sql = "SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
                    FROM transactions
                    WHERE user_id = ? AND type = 'expense' AND category_id = ? AND date >= ? AND date <= ?";
            $params = [$uid, $item['categoryId'], $from, $to];
            if ($item['matchKeyword'] !== null) {
                $sql .= " AND LOWER(note) LIKE ? ESCAPE '!'";
                $params[] = '%' . str_replace(['!', '%', '_'], ['!!', '!%', '!_'], mb_strtolower($item['matchKeyword'])) . '%';
            }
            $row = DB::one($sql, $params);
            $item['estimateFrom'] = $from;
            $item['estimateTo'] = $to;
            // null = no history yet (the client falls back to amountCents).
            $item['estimateCents'] = $row !== null && (int)$row['n'] > 0 ? (int)round((int)$row['total'] / 3) : null;
        }
        return $item;
    }

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function castSchedulePayment(array $r): array
    {
        return [
            'id' => (int)$r['id'],
            'itemId' => (int)$r['itemId'],
            'dueDate' => (string)$r['dueDate'],
            'transferId' => $r['transferId'] === null ? null : (int)$r['transferId'],
            'transactionId' => $r['transactionId'] === null ? null : (int)$r['transactionId'],
            'amountCents' => (int)$r['amountCents'],
            'paidDate' => (string)$r['paidDate'],
        ];
    }

    /** @return array{0: string, 1: string} first..last day of the 3 complete months before this one */
    private static function estimateWindow(): array
    {
        $y = (int)date('Y');
        $m = (int)date('n');
        return [
            date('Y-m-d', (int)mktime(12, 0, 0, $m - 3, 1, $y)),
            date('Y-m-d', (int)mktime(12, 0, 0, $m, 0, $y)), // day 0 = last day of last month
        ];
    }

    private static function requiredDueDay(mixed $v, string $message): int
    {
        $day = Validate::dueDayOrNull($v);
        if ($day === null) {
            throw new ApiError($message, 422);
        }
        return $day;
    }

    /** A funding payday must be one of the user's own income items (null = automatic). */
    private static function cleanFundedBy(int $uid, mixed $v): ?int
    {
        if ($v === null || $v === '') {
            return null;
        }
        $id = Validate::intId($v);
        if (DB::one("SELECT id FROM schedule_items WHERE id = ? AND user_id = ? AND kind = 'income'", [$id, $uid]) === null) {
            throw new ApiError('Funding payday must be one of your paydays', 422);
        }
        return $id;
    }

    /**
     * Validates an item for its kind and returns the full column set. Fields
     * that don't apply to the kind are forced to their neutral value, so a
     * stored row never carries settings it ignores.
     *
     * @param array<string, mixed> $data
     * @param array<string, mixed>|null $existing the row being updated (kind and subscription are immutable)
     * @return array<string, mixed> column => value
     */
    private static function cleanScheduleInput(int $uid, string $kind, array $data, ?array $existing): array
    {
        $startDate = Validate::dateOrNull($data['startDate'] ?? null)
            ?? ($existing !== null ? (string)$existing['start_date'] : date('Y-m-d'));
        $row = [
            'name' => '',
            'account_id' => null,
            'subscription_id' => null,
            'category_id' => null,
            'amount_mode' => 'fixed',
            'amount_cents' => 0,
            'match_keyword' => null,
            'due_day' => null,
            'week_day' => null,
            'funded_by' => null,
            'weekend_shift' => 'none',
            'start_date' => $startDate,
            'end_date' => Validate::dateOrNull($data['endDate'] ?? null),
            'goal_cents' => null,
            'goal_milestones' => null,
            'pay_from_account_id' => null,
            'active' => (!array_key_exists('active', $data) || (bool)$data['active']) ? 1 : 0,
        ];
        if ($row['end_date'] !== null && $row['end_date'] < $startDate) {
            throw new ApiError('End date must be on or after the start date', 422);
        }

        // Subscriptions keep their own amount, dates and account; the schedule
        // row only says which payday funds them.
        if ($kind === 'subscription') {
            $subId = $existing !== null
                ? (int)$existing['subscription_id']
                : Validate::intId($data['subscriptionId'] ?? null);
            $sub = DB::one('SELECT name FROM subscriptions WHERE id = ? AND user_id = ?', [$subId, $uid]);
            if ($sub === null) {
                throw new ApiError('Invalid subscription', 422);
            }
            $row['name'] = (string)$sub['name'];
            $row['subscription_id'] = $subId;
            $row['end_date'] = null;
            $row['funded_by'] = self::cleanFundedBy($uid, $data['fundedBy'] ?? null);
            return $row;
        }

        $row['name'] = Validate::name($data['name'] ?? null);
        $accountId = Validate::accountIdOrNull($data['accountId'] ?? null);
        $categoryId = Validate::categoryIdOrNull($data['categoryId'] ?? null);

        if ($kind === 'income') {
            $row['amount_cents'] = Validate::amountCents($data['amountCents'] ?? null);
            $row['due_day'] = self::requiredDueDay($data['dueDay'] ?? null, 'Choose the payday (day of the month)');
            $row['weekend_shift'] = Validate::weekendShift($data['weekendShift'] ?? 'before');
            if ($accountId !== null && self::assertAccountOwned($uid, $accountId) !== 'debit') {
                throw new ApiError('Salary must land in a debit account', 422);
            }
            if ($categoryId !== null) {
                self::assertCategoryOwned($uid, $categoryId, 'income');
            }
            $row['account_id'] = $accountId;
            $row['category_id'] = $categoryId;
            return $row;
        }

        // Every outflow: an optional default source account, and the payday
        // that funds it (weekly allowances are funded by whichever payday
        // precedes each week, so they never pin one).
        $payFrom = Validate::accountIdOrNull($data['payFromAccountId'] ?? null);
        if ($payFrom !== null && self::assertAccountOwned($uid, $payFrom) === 'loan') {
            throw new ApiError('Pay from a debit or credit account', 422);
        }
        $row['pay_from_account_id'] = $payFrom;
        $row['funded_by'] = $kind === 'allowance' ? null : self::cleanFundedBy($uid, $data['fundedBy'] ?? null);

        switch ($kind) {
            case 'loan':
            case 'card':
                // Due days live on the account itself (one source of truth).
                $want = $kind === 'loan' ? 'loan' : 'credit';
                if ($accountId === null || self::assertAccountOwned($uid, $accountId) !== $want) {
                    throw new ApiError($kind === 'loan' ? 'Choose a loan account' : 'Choose a credit card account', 422);
                }
                $row['account_id'] = $accountId;
                $row['amount_cents'] = Validate::amountCents($data['amountCents'] ?? null);
                break;
            case 'bill':
                if ($categoryId === null) {
                    throw new ApiError('Choose an expense category for this bill', 422);
                }
                self::assertCategoryOwned($uid, $categoryId, 'expense');
                $row['category_id'] = $categoryId;
                $row['due_day'] = self::requiredDueDay($data['dueDay'] ?? null, 'Choose the due day');
                $row['amount_mode'] = Validate::scheduleAmountMode($data['amountMode'] ?? 'fixed');
                $avg3 = $row['amount_mode'] === 'avg3';
                // An avg3 bill may have no fallback amount (0 until there's history).
                $row['amount_cents'] = Validate::amountCents($data['amountCents'] ?? ($avg3 ? 0 : null), $avg3);
                // Narrows which expenses in the category belong to this bill —
                // for the avg3 estimate, and (client-side) for recognizing a
                // payment made outside the Schedule, so a fixed Water bill
                // isn't "paid" by an electricity expense in the same category.
                $row['match_keyword'] = Validate::keywordOrNull($data['matchKeyword'] ?? null);
                break;
            case 'allowance':
                $row['week_day'] = Validate::weekDay($data['weekDay'] ?? null);
                $row['amount_cents'] = Validate::amountCents($data['amountCents'] ?? null);
                if ($categoryId !== null) {
                    self::assertCategoryOwned($uid, $categoryId, 'expense');
                }
                $row['category_id'] = $categoryId;
                break;
            case 'savings':
                if ($accountId === null || self::assertAccountOwned($uid, $accountId) !== 'debit') {
                    throw new ApiError('Choose the debit account your savings go into', 422);
                }
                if ($payFrom === $accountId) {
                    throw new ApiError('Pay from a different account than the savings account', 422);
                }
                $row['account_id'] = $accountId;
                $row['due_day'] = self::requiredDueDay($data['dueDay'] ?? null, 'Choose the day you set money aside');
                $row['amount_cents'] = Validate::amountCents($data['amountCents'] ?? null);
                $goal = $data['goalCents'] ?? null;
                $row['goal_cents'] = $goal === null || $goal === '' ? null : Validate::amountCents($goal);
                // Checkpoints on the way to the goal; with no goal set, the
                // largest milestone is the goal.
                $milestones = Validate::milestones($data['goalMilestones'] ?? null);
                if ($milestones !== []) {
                    $top = $milestones[count($milestones) - 1];
                    if ($row['goal_cents'] === null) {
                        $row['goal_cents'] = $top;
                    } elseif ($top > $row['goal_cents']) {
                        throw new ApiError('Milestones can\'t be above the goal', 422);
                    }
                    $row['goal_milestones'] = implode(',', $milestones);
                }
                break;
        }
        return $row;
    }

    /** @return array<string, mixed> */
    private static function scheduleItem(int $uid, int $id): array
    {
        $row = DB::one(self::SCHEDULE_SELECT . ' WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($row === null) {
            throw new ApiError('Schedule item not found', 404);
        }
        return self::castScheduleItem($uid, $row);
    }

    /**
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function createScheduleItem(int $uid, array $data): array
    {
        $kind = Validate::scheduleKind($data['kind'] ?? null);
        $row = self::cleanScheduleInput($uid, $kind, $data, null);
        if (
            $kind === 'subscription'
            && DB::one('SELECT id FROM schedule_items WHERE subscription_id = ? AND user_id = ?', [$row['subscription_id'], $uid]) !== null
        ) {
            throw new ApiError('That subscription is already on your schedule', 409);
        }
        $cols = array_keys($row);
        $id = DB::insert(
            'INSERT INTO schedule_items (user_id, kind, ' . implode(', ', $cols) . ')
             VALUES (?, ?, ' . implode(', ', array_fill(0, count($cols), '?')) . ')',
            [$uid, $kind, ...array_values($row)]
        );
        return self::scheduleItem($uid, $id);
    }

    /**
     * Kind is immutable (it decides how past payments were recorded), as is a
     * subscription row's subscription.
     * @param array<string, mixed> $data
     */
    public static function updateScheduleItem(int $uid, int $id, array $data): void
    {
        $existing = DB::one(
            'SELECT kind, subscription_id, start_date FROM schedule_items WHERE id = ? AND user_id = ?',
            [$id, $uid]
        );
        if ($existing === null) {
            throw new ApiError('Schedule item not found', 404);
        }
        $row = self::cleanScheduleInput($uid, (string)$existing['kind'], $data, $existing);
        $set = implode(', ', array_map(static fn(string $c): string => "$c = ?", array_keys($row)));
        DB::exec(
            "UPDATE schedule_items SET $set WHERE id = ? AND user_id = ?",
            [...array_values($row), $id, $uid]
        );
    }

    public static function deleteScheduleItem(int $uid, int $id): void
    {
        // Items this payday funded fall back to automatic funding. Payment
        // links cascade away; the transfers/transactions they point to stay.
        DB::exec('UPDATE schedule_items SET funded_by = NULL WHERE funded_by = ? AND user_id = ?', [$id, $uid]);
        $count = DB::exec('DELETE FROM schedule_items WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($count === 0) {
            throw new ApiError('Schedule item not found', 404);
        }
    }

    /**
     * "Mark as paid": records the payment through the normal ledger paths
     * (createTransfer / createTransaction, with all their validation) and
     * links it to the occurrence, atomically. Any amount is accepted — less
     * than due is a partial payment, more is an extra one.
     *   loan / card / savings → transfer from the chosen account to the item's account
     *   bill / allowance      → expense transaction in the item's category
     *   income                → income transaction into the deposit account ("log actual")
     * Subscriptions are refused: they're charged automatically.
     *
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function paySchedule(int $uid, array $data): array
    {
        $itemId = Validate::intId($data['itemId'] ?? null);
        $item = DB::one(
            'SELECT name, kind, account_id, category_id, pay_from_account_id FROM schedule_items WHERE id = ? AND user_id = ?',
            [$itemId, $uid]
        );
        if ($item === null) {
            throw new ApiError('Schedule item not found', 404);
        }
        $kind = (string)$item['kind'];
        if ($kind === 'subscription') {
            throw new ApiError('Subscriptions are charged automatically', 422);
        }
        $dueDate = Validate::date($data['dueDate'] ?? null);
        $name = (string)$item['name'];
        $itemAccount = $item['account_id'] === null ? null : (int)$item['account_id'];
        $categoryId = $item['category_id'] === null ? null : (int)$item['category_id'];
        $usesTransfer = in_array($kind, ['loan', 'card', 'savings'], true);

        // The cash side: where the money comes from (for income, where it lands).
        $defaultAccount = $kind === 'income'
            ? $itemAccount
            : ($item['pay_from_account_id'] === null ? null : (int)$item['pay_from_account_id']);
        $accountId = Validate::accountIdOrNull($data['accountId'] ?? null) ?? $defaultAccount;
        if ($accountId === null) {
            throw new ApiError($kind === 'income' ? 'Choose the account the salary landed in' : 'Choose an account to pay from', 422);
        }
        $accountType = self::assertAccountOwned($uid, $accountId);
        if ($kind === 'income' && $accountType !== 'debit') {
            throw new ApiError('Salary must land in a debit account', 422);
        }
        if ($usesTransfer) {
            if ($itemAccount === null) {
                throw new ApiError("This item's account was deleted", 422);
            }
            if ($accountType === 'loan') {
                throw new ApiError('Pay from a debit or credit account', 422);
            }
        }
        $fee = Validate::feeCents($data['feeCents'] ?? null);
        if ($fee > 0 && !$usesTransfer) {
            throw new ApiError('Only payments to an account can carry a fee', 422);
        }
        $note = trim(Validate::note($data['note'] ?? ''));
        $base = [
            'amountCents' => $data['amountCents'] ?? null,
            'date' => $data['date'] ?? null,
            'time' => $data['time'] ?? null,
        ];

        $pdo = DB::pdo();
        $pdo->beginTransaction();
        try {
            $transfer = null;
            $transaction = null;
            if ($usesTransfer) {
                $transfer = self::createTransfer($uid, $base + [
                    'fromAccountId' => $accountId,
                    'toAccountId' => $itemAccount,
                    'feeCents' => $fee,
                    'note' => $note !== '' ? $note : ($kind === 'savings' ? "Savings: $name" : "Payment to $name"),
                ]);
            } else {
                $transaction = self::createTransaction($uid, $base + [
                    'type' => $kind === 'income' ? 'income' : 'expense',
                    'categoryId' => $categoryId,
                    'accountId' => $accountId,
                    'note' => $note !== '' ? $note : $name,
                ]);
            }
            $linkId = DB::insert(
                'INSERT INTO schedule_payments (user_id, item_id, due_date, transfer_id, transaction_id) VALUES (?, ?, ?, ?, ?)',
                [$uid, $itemId, $dueDate, $transfer['id'] ?? null, $transaction['id'] ?? null]
            );
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $link = DB::one(self::SCHEDULE_PAYMENT_SELECT . ' WHERE sp.id = ? AND sp.user_id = ?', [$linkId, $uid]);
        assert($link !== null);
        return ['payment' => self::castSchedulePayment($link), 'transfer' => $transfer, 'transaction' => $transaction];
    }
}

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
     * Live balance ledger per account:
     *   opening + income tx − expense tx − (outgoing transfers + fees) + incoming transfers
     * Positive = money you have; negative = money you owe (credit/loan).
     *
     * @return array<int, array<string, mixed>>
     */
    public static function listAccounts(int $uid): array
    {
        $rows = DB::all(
            "SELECT a.id, a.name, a.type, a.color, a.image,
                    a.due_day AS dueDay, a.due_day2 AS dueDay2,
                    a.opening_balance_cents AS openingBalanceCents,
                    a.opening_balance_cents
                    + COALESCE((SELECT SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END)
                                FROM transactions t WHERE t.account_id = a.id), 0)
                    - COALESCE((SELECT SUM(tro.amount_cents + tro.fee_cents)
                                FROM transfers tro WHERE tro.from_account_id = a.id), 0)
                    + COALESCE((SELECT SUM(tri.amount_cents)
                                FROM transfers tri WHERE tri.to_account_id = a.id), 0)
                      AS balanceCents,
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
            'openingBalanceCents' => (int)$r['openingBalanceCents'],
            'balanceCents' => (int)$r['balanceCents'],
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

    /** @return array<string, mixed> */
    public static function createAccount(int $uid, mixed $name, mixed $type, mixed $color, mixed $openingBalanceCents, mixed $image = null, mixed $dueDay = null, mixed $dueDay2 = null): array
    {
        $name = Validate::name($name);
        $type = Validate::accountType($type);
        $color = Validate::color($color);
        $image = Validate::accountImage($image);
        [$dueDay, $dueDay2] = self::dueDaysFor($type, $dueDay, $dueDay2);
        $opening = self::signedOpening($type, $openingBalanceCents);
        $id = DB::insert(
            'INSERT INTO accounts (user_id, name, type, color, image, due_day, due_day2, opening_balance_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$uid, $name, $type, $color, $image, $dueDay, $dueDay2, $opening]
        );
        return [
            'id' => $id,
            'name' => $name,
            'type' => $type,
            'color' => $color,
            'image' => $image,
            'dueDay' => $dueDay,
            'dueDay2' => $dueDay2,
            'openingBalanceCents' => $opening,
            'balanceCents' => $opening,
            'txCount' => 0,
            'transferCount' => 0,
        ];
    }

    /** Type is immutable after creation (changing it would re-interpret history). */
    public static function updateAccount(int $uid, int $id, mixed $name, mixed $color, mixed $openingBalanceCents, mixed $image = null, mixed $dueDay = null, mixed $dueDay2 = null): void
    {
        $name = Validate::name($name);
        $color = Validate::color($color);
        $image = Validate::accountImage($image);
        // Sign the opening balance using the account's existing (immutable) type.
        $existing = DB::one('SELECT type FROM accounts WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($existing === null) {
            throw new ApiError('Account not found', 404);
        }
        [$dueDay, $dueDay2] = self::dueDaysFor((string)$existing['type'], $dueDay, $dueDay2);
        $opening = self::signedOpening((string)$existing['type'], $openingBalanceCents);
        DB::exec(
            'UPDATE accounts SET name = ?, color = ?, image = ?, due_day = ?, due_day2 = ?, opening_balance_cents = ? WHERE id = ? AND user_id = ?',
            [$name, $color, $image, $dueDay, $dueDay2, $opening, $id, $uid]
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
     * @return array{0: int, 1: int, 2: int, 3: int, 4: string, 5: string} from, to, amount, fee, date, note
     */
    private static function cleanTransferInput(int $uid, array $data): array
    {
        $from = Validate::intId($data['fromAccountId'] ?? null);
        $to = Validate::intId($data['toAccountId'] ?? null);
        if ($from === $to) {
            throw new ApiError('Choose two different accounts', 422);
        }
        self::assertAccountOwned($uid, $from);
        self::assertAccountOwned($uid, $to);
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

    /**
     * One row per expense category (budget may be unset = amount 0). `spentCents`
     * is the category's expense total within the current period of that row's
     * cadence, so the progress shown is against the right window.
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
        return array_map(static fn(array $r): array => [
            'id' => (int)$r['id'],
            'categoryId' => (int)$r['categoryId'],
            'cadence' => (string)$r['cadence'],
            'amountCents' => (int)$r['amountCents'],
            'categoryName' => (string)$r['categoryName'],
            'categoryColor' => (string)$r['categoryColor'],
            'spentCents' => (int)$r['spentCents'],
        ], $rows);
    }

    public static function upsertBudget(int $uid, mixed $categoryId, mixed $cadence, mixed $amountCents): void
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
        if (DB::driver() === 'sqlite') {
            DB::exec(
                'INSERT INTO budgets (user_id, category_id, cadence, amount_cents) VALUES (?, ?, ?, ?)
                 ON CONFLICT (category_id) DO UPDATE SET cadence = excluded.cadence, amount_cents = excluded.amount_cents',
                [$uid, $categoryId, $cadence, $amount]
            );
        } else {
            DB::exec(
                'INSERT INTO budgets (user_id, category_id, cadence, amount_cents) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE cadence = VALUES(cadence), amount_cents = VALUES(amount_cents)',
                [$uid, $categoryId, $cadence, $amount]
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
}

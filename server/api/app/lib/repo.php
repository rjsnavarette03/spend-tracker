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
            'SELECT t.id, t.amount_cents AS amountCents, t.type, t.category_id AS categoryId,
                    t.account_id AS accountId, t.date, t.note,
                    c.name AS categoryName, c.color AS categoryColor,
                    a.name AS accountName, a.color AS accountColor
             FROM transactions t
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN accounts a ON a.id = t.account_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY t.date DESC, t.id DESC
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
     * @return array{0: int, 1: string, 2: ?int, 3: ?int, 4: string, 5: string} amount, type, categoryId, accountId, date, note
     */
    private static function cleanTxInput(int $uid, array $data): array
    {
        $amount = Validate::amountCents($data['amountCents'] ?? null);
        $type = Validate::type($data['type'] ?? null);
        $categoryId = Validate::categoryIdOrNull($data['categoryId'] ?? null);
        $accountId = Validate::accountIdOrNull($data['accountId'] ?? null);
        $date = Validate::date($data['date'] ?? null);
        $note = Validate::note($data['note'] ?? '');
        if ($categoryId !== null) {
            // Category must belong to the user AND match the tx type, so an
            // income tx can't reference an expense category (would corrupt
            // the by-category breakdown). Mirrors the upsertBudget check.
            self::assertCategoryOwned($uid, $categoryId, $type);
        }
        if ($accountId !== null) {
            self::assertAccountOwned($uid, $accountId);
        }
        return [$amount, $type, $categoryId, $accountId, $date, $note];
    }

    /**
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function createTransaction(int $uid, array $data): array
    {
        [$amount, $type, $categoryId, $accountId, $date, $note] = self::cleanTxInput($uid, $data);
        $id = DB::insert(
            'INSERT INTO transactions (user_id, amount_cents, type, category_id, account_id, date, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$uid, $amount, $type, $categoryId, $accountId, $date, $note]
        );
        $row = DB::one(
            'SELECT t.id, t.amount_cents AS amountCents, t.type, t.category_id AS categoryId,
                    t.account_id AS accountId, t.date, t.note,
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
        [$amount, $type, $categoryId, $accountId, $date, $note] = self::cleanTxInput($uid, $data);
        if (DB::one('SELECT id FROM transactions WHERE id = ? AND user_id = ?', [$id, $uid]) === null) {
            throw new ApiError('Transaction not found', 404);
        }
        DB::exec(
            'UPDATE transactions SET amount_cents = ?, type = ?, category_id = ?, account_id = ?, date = ?, note = ?
             WHERE id = ? AND user_id = ?',
            [$amount, $type, $categoryId, $accountId, $date, $note, $id, $uid]
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

    /** @return array<string, mixed> */
    public static function createAccount(int $uid, mixed $name, mixed $type, mixed $color, mixed $openingBalanceCents, mixed $image = null): array
    {
        $name = Validate::name($name);
        $type = Validate::accountType($type);
        $color = Validate::color($color);
        $image = Validate::accountImage($image);
        $opening = self::signedOpening($type, $openingBalanceCents);
        $id = DB::insert(
            'INSERT INTO accounts (user_id, name, type, color, image, opening_balance_cents) VALUES (?, ?, ?, ?, ?, ?)',
            [$uid, $name, $type, $color, $image, $opening]
        );
        return [
            'id' => $id,
            'name' => $name,
            'type' => $type,
            'color' => $color,
            'image' => $image,
            'openingBalanceCents' => $opening,
            'balanceCents' => $opening,
            'txCount' => 0,
            'transferCount' => 0,
        ];
    }

    /** Type is immutable after creation (changing it would re-interpret history). */
    public static function updateAccount(int $uid, int $id, mixed $name, mixed $color, mixed $openingBalanceCents, mixed $image = null): void
    {
        $name = Validate::name($name);
        $color = Validate::color($color);
        $image = Validate::accountImage($image);
        // Sign the opening balance using the account's existing (immutable) type.
        $existing = DB::one('SELECT type FROM accounts WHERE id = ? AND user_id = ?', [$id, $uid]);
        if ($existing === null) {
            throw new ApiError('Account not found', 404);
        }
        $opening = self::signedOpening((string)$existing['type'], $openingBalanceCents);
        DB::exec(
            'UPDATE accounts SET name = ?, color = ?, image = ?, opening_balance_cents = ? WHERE id = ? AND user_id = ?',
            [$name, $color, $image, $opening, $id, $uid]
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

    private static function assertAccountOwned(int $uid, int $accountId): void
    {
        if (DB::one('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [$accountId, $uid]) === null) {
            throw new ApiError('Invalid account', 422);
        }
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
        $note = Validate::note($data['note'] ?? '');
        return [$from, $to, $amount, $fee, $date, $note];
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
            'SELECT tr.id, tr.from_account_id AS fromAccountId, tr.to_account_id AS toAccountId,
                    tr.amount_cents AS amountCents, tr.fee_cents AS feeCents, tr.date, tr.note,
                    fa.name AS fromName, fa.color AS fromColor,
                    ta.name AS toName, ta.color AS toColor
             FROM transfers tr
             LEFT JOIN accounts fa ON fa.id = tr.from_account_id
             LEFT JOIN accounts ta ON ta.id = tr.to_account_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY tr.date DESC, tr.id DESC
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
        [$from, $to, $amount, $fee, $date, $note] = self::cleanTransferInput($uid, $data);
        $id = DB::insert(
            'INSERT INTO transfers (user_id, from_account_id, to_account_id, amount_cents, fee_cents, date, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$uid, $from, $to, $amount, $fee, $date, $note]
        );
        $row = DB::one(
            'SELECT tr.id, tr.from_account_id AS fromAccountId, tr.to_account_id AS toAccountId,
                    tr.amount_cents AS amountCents, tr.fee_cents AS feeCents, tr.date, tr.note,
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
        [$from, $to, $amount, $fee, $date, $note] = self::cleanTransferInput($uid, $data);
        if (DB::one('SELECT id FROM transfers WHERE id = ? AND user_id = ?', [$id, $uid]) === null) {
            throw new ApiError('Transfer not found', 404);
        }
        DB::exec(
            'UPDATE transfers SET from_account_id = ?, to_account_id = ?, amount_cents = ?, fee_cents = ?, date = ?, note = ?
             WHERE id = ? AND user_id = ?',
            [$from, $to, $amount, $fee, $date, $note, $id, $uid]
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
}

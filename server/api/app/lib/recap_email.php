<?php
declare(strict_types=1);

/**
 * The monthly recap email (cron/send-reminders.php): last month's money in
 * and out against the month before, where it went, monthly budgets that went
 * over, and net worth and debt at the month's end. Plain text like the other
 * emails. It has its own unsubscribe link (list=recap), in the body and as
 * List-Unsubscribe headers, so stopping it leaves the reminders alone.
 */
final class RecapEmail
{
    /**
     * @param array<string, mixed> $user users row: name, currency
     * @param array<string, mixed> $recap Repo::monthRecap()
     * @return array{subject: string, body: string, headers: list<string>}
     */
    public static function monthly(array $user, array $recap, string $token): array
    {
        $currency = (string)$user['currency'];
        $m = static fn(int $cents): string => ReminderEmail::money($cents, $currency);
        $name = trim((string)$user['name']);
        $month = self::monthName((string)$recap['month'], true);
        $prev = self::monthName((string)$recap['prevMonth'], false);
        $income = (int)$recap['incomeCents'];
        $spent = (int)$recap['expenseCents'];
        $unsub = self::unsubscribe($token);

        $body = ($name === '' ? 'Hello' : "Hello $name") . ",\n\nHere's your $month in SpendTracker.\n"
            . "\nMONEY IN AND OUT\n"
            . '  - Income: ' . $m($income) . self::change($income, (int)$recap['prevIncomeCents'], $m, $prev) . "\n"
            . '  - Spending: ' . $m($spent) . self::change($spent, (int)$recap['prevExpenseCents'], $m, $prev) . "\n";
        if ($income > 0) {
            $kept = $income - $spent;
            $body .= $kept >= 0
                ? '  - Kept: ' . $m($kept) . ', ' . (int)round($kept / $income * 100) . "% of income\n"
                : '  - Spent ' . $m(-$kept) . " more than came in\n";
        }

        if ($recap['topCategories'] !== []) {
            $body .= "\nWHERE IT WENT\n";
            foreach ($recap['topCategories'] as $c) {
                $share = $spent > 0 ? ' (' . (int)round($c['totalCents'] / $spent * 100) . '%)' : '';
                $body .= '  - ' . $c['name'] . ': ' . $m((int)$c['totalCents']) . $share . "\n";
            }
        }

        $budgets = (int)$recap['monthlyBudgets'];
        if ($budgets > 0) {
            $body .= "\nMONTHLY BUDGETS\n";
            if ($recap['overBudget'] === []) {
                $body .= $budgets === 1 ? "  - Your budget stayed within its limit\n" : "  - All $budgets stayed within their limits\n";
            }
            foreach ($recap['overBudget'] as $b) {
                $body .= '  - Over: ' . $b['name'] . ', ' . $m((int)$b['spentCents']) . ' of ' . $m((int)$b['limitCents']) . "\n";
            }
        }

        $end = $recap['netWorth'];
        if ($end !== null) {
            $start = $recap['prevNetWorth'];
            $than = 'the end of ' . $prev;
            $body .= "\nNET WORTH AT THE END OF " . strtoupper(self::monthName((string)$recap['month'], false)) . "\n"
                . '  - Net worth: ' . $m((int)$end['netCents'])
                . ($start !== null ? self::change((int)$end['netCents'], (int)$start['netCents'], $m, $than) : '') . "\n";
            if ($end['liabilitiesCents'] > 0 || ($start !== null && $start['liabilitiesCents'] > 0)) {
                // Every negative balance: loans, cards and any overdrawn account.
                $body .= '  - Total owed: ' . $m((int)$end['liabilitiesCents'])
                    . ($start !== null ? self::change((int)$end['liabilitiesCents'], (int)$start['liabilitiesCents'], $m, $than) : '') . "\n";
            }
        }

        $body .= "\nSee the details:\n" . Mailer::appBaseUrl() . "/dashboard\n\n"
            . "You're getting this because the monthly recap is on for your SpendTracker account. "
            . "To stop it, turn it off in Settings or open this link:\n\n"
            . $unsub['page'] . "\n\n"
            . '— SpendTracker';

        return ['subject' => "Your $month recap: " . $m($spent) . ' spent', 'body' => $body, 'headers' => $unsub['headers']];
    }

    /**
     * The recap's unsubscribe links, like ReminderEmail::unsubscribe() but
     * for the recap's own list and token.
     *
     * @return array{page: string, headers: list<string>}
     */
    public static function unsubscribe(string $token): array
    {
        $base = Mailer::appBaseUrl();
        return [
            'page' => $base . '/?unsubscribe=' . $token . '&list=recap',
            'headers' => [
                'List-Unsubscribe: <' . $base . '/api/reminders/unsubscribe?token=' . $token . '&list=recap>',
                'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
            ],
        ];
    }

    /** " (up $2.00 from October)", " (same as October)", or nothing when both are zero. */
    private static function change(int $now, int $before, callable $money, string $than): string
    {
        if ($now === 0 && $before === 0) {
            return '';
        }
        $diff = $now - $before;
        if ($diff === 0) {
            return " (same as $than)";
        }
        return ' (' . ($diff > 0 ? 'up ' : 'down ') . $money(abs($diff)) . " from $than)";
    }

    /** 'November 2026' or 'November'. */
    private static function monthName(string $month, bool $withYear): string
    {
        return (new DateTimeImmutable($month . '-01', new DateTimeZone('UTC')))->format($withYear ? 'F Y' : 'F');
    }
}

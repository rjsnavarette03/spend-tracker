<?php
declare(strict_types=1);

/**
 * The reminder emails' text: the daily list (cron/send-reminders.php) and the
 * confirmation sent when reminders are turned on. Plain text like the other
 * emails, and each carries its unsubscribe link both in the body and as
 * List-Unsubscribe headers.
 */
final class ReminderEmail
{
    /** Local hour from which the day's email goes out. */
    public const SEND_HOUR = 7;

    /** The bell's groups, in its order and words. */
    private const GROUPS = [
        'overdue' => 'Overdue',
        'unlogged' => 'Salary not logged yet',
        'today' => 'Today',
        'soon' => 'Next ' . Reminders::REMIND_DAYS . ' days',
    ];

    /**
     * The day's email: every current reminder, grouped like the bell.
     *
     * @param array<string, mixed> $user users row: name, currency
     * @param list<array<string, mixed>> $reminders Reminders::build() — not empty
     * @return array{subject: string, body: string, headers: list<string>}
     */
    public static function daily(array $user, array $reminders, string $today, string $token): array
    {
        $currency = (string)$user['currency'];
        $name = trim((string)$user['name']);
        $unsub = self::unsubscribe($token);

        $body = ($name === '' ? 'Hello' : "Hello $name") . ",\n\n"
            . 'Here is what needs your attention today, ' . self::dateLabel($today) . ":\n";
        foreach (self::GROUPS as $stage => $title) {
            $lines = array_filter($reminders, static fn(array $r): bool => $r['stage'] === $stage);
            if ($lines === []) {
                continue;
            }
            $body .= "\n" . strtoupper($title) . "\n";
            foreach ($lines as $r) {
                $body .= '  - ' . self::line($r, $currency) . "\n";
            }
        }
        $body .= "\nMark them paid or log your salary in the planner:\n"
            . Mailer::appBaseUrl() . "/schedule\n\n"
            . "You're getting this because reminder emails are on for your SpendTracker account. "
            . "To stop them, turn them off in Settings or open this link:\n\n"
            . $unsub['page'] . "\n\n"
            . '— SpendTracker';

        return ['subject' => self::subject($reminders), 'body' => $body, 'headers' => $unsub['headers']];
    }

    /**
     * Sent when reminders are turned on: confirms what to expect — and that
     * our mail reaches the inbox (or lands in spam) now, not on a due date.
     *
     * @return array{subject: string, body: string, headers: list<string>}
     */
    public static function turnedOn(string $timezone, string $token): array
    {
        $unsub = self::unsubscribe($token);
        $body = "Hello,\n\n"
            . 'Reminder emails are now on for your SpendTracker account. Around ' . self::SEND_HOUR . ':00 AM '
            . "({$timezone} time), on days when something needs your attention, we'll email you "
            . "a list of:\n\n"
            . '  - bills and payments due today or in the next ' . Reminders::REMIND_DAYS . " days\n"
            . "  - anything overdue\n"
            . "  - paydays whose salary hasn't been logged yet\n\n"
            . "You'll get at most one email a day, and none on days with nothing new.\n\n"
            . "To stop them, turn them off in Settings or open this link:\n\n"
            . $unsub['page'] . "\n\n"
            . '— SpendTracker';
        return ['subject' => 'Reminder emails are on', 'body' => $body, 'headers' => $unsub['headers']];
    }

    /**
     * The unsubscribe links for a reminder email: `page` for the body (the
     * app's screen asks before turning anything off) and `headers` for mail
     * providers' own unsubscribe button (RFC 2369, with RFC 8058 one-click).
     *
     * @return array{page: string, headers: list<string>}
     */
    public static function unsubscribe(string $token): array
    {
        $base = Mailer::appBaseUrl();
        return [
            'page' => $base . '/?unsubscribe=' . $token,
            'headers' => [
                'List-Unsubscribe: <' . $base . '/api/reminders/unsubscribe?token=' . $token . '>',
                'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
            ],
        ];
    }

    /** One item names it ("Reminder: Water is due today"); several are counted. */
    private static function subject(array $reminders): string
    {
        if (count($reminders) === 1) {
            $r = $reminders[0];
            if ($r['kind'] === 'payday') {
                return $r['stage'] === 'today'
                    ? "Reminder: {$r['name']} is expected today"
                    : "Reminder: {$r['name']} isn't logged yet";
            }
            return match ($r['stage']) {
                'overdue' => "Reminder: {$r['name']} is overdue",
                'today' => "Reminder: {$r['name']} is due today",
                default => "Reminder: {$r['name']} is due " . self::dateLabel($r['date']),
            };
        }
        $count = static fn(callable $match): int => count(array_filter($reminders, $match));
        $paydays = $count(static fn(array $r): bool => $r['kind'] === 'payday');
        $parts = array_filter([
            ($n = $count(static fn(array $r): bool => $r['stage'] === 'overdue')) > 0 ? "$n overdue" : null,
            ($n = $count(static fn(array $r): bool => $r['kind'] === 'due' && $r['stage'] === 'today')) > 0 ? "$n due today" : null,
            $paydays > 0 ? $paydays . ($paydays === 1 ? ' payday' : ' paydays') . ' to log' : null,
            ($n = $count(static fn(array $r): bool => $r['stage'] === 'soon')) > 0 ? "$n coming up" : null,
        ]);
        return 'Reminders: ' . implode(', ', $parts);
    }

    /**
     *   Water — $450.00
     *   Card — $3,000.00 left of $5,000.00, was due Tue, Oct 20
     *   Netflix — $5.49, due Sat, Oct 31 (charged automatically)
     *   Salary — $25,000.00 expected Fri, Oct 30
     */
    private static function line(array $r, string $currency): string
    {
        if ($r['kind'] === 'payday') {
            $when = 'expected ' . ($r['stage'] === 'today' ? 'today' : self::dateLabel($r['date']));
            return $r['name'] . ' — ' . ($r['amountCents'] > 0 ? self::money($r['amountCents'], $currency) . ' ' : '') . $when;
        }
        $parts = [];
        if ($r['state'] === 'partial') {
            $parts[] = self::money($r['remainingCents'], $currency) . ' left of ' . self::money($r['amountCents'], $currency);
        } elseif ($r['remainingCents'] > 0) {
            $parts[] = self::money($r['remainingCents'], $currency); // a bill with no estimate yet has none
        }
        if ($r['stage'] === 'overdue') {
            $parts[] = 'was due ' . self::dateLabel($r['date']);
        } elseif ($r['stage'] === 'soon') {
            $parts[] = 'due ' . self::dateLabel($r['date']);
        }
        return $r['name'] . ($parts === [] ? '' : ' — ' . implode(', ', $parts))
            . ($r['itemKind'] === 'subscription' ? ' (charged automatically)' : '');
    }

    /** Like the app's money(): en-US currency format, from cents. */
    public static function money(int $cents, string $currency): string
    {
        if (class_exists('NumberFormatter')) {
            $out = (new NumberFormatter('en_US', NumberFormatter::CURRENCY))->formatCurrency($cents / 100, $currency);
            if ($out !== false) {
                return $out;
            }
        }
        // Without intl (local XAMPP): the common symbols, else the ISO code.
        $symbols = ['PHP' => '₱', 'USD' => '$', 'EUR' => '€', 'GBP' => '£', 'JPY' => '¥'];
        $decimals = $currency === 'JPY' ? 0 : 2;
        // The sign goes before the symbol, as NumberFormatter writes it (-₱3.00).
        $sign = $cents < 0 ? '-' : '';
        $amount = number_format(abs($cents) / 100, $decimals);
        return $sign . (isset($symbols[$currency]) ? $symbols[$currency] . $amount : "$currency $amount");
    }

    /** 'Fri, Oct 30', like the app's shortDateLabel. */
    private static function dateLabel(string $date): string
    {
        return (new DateTimeImmutable($date, new DateTimeZone('UTC')))->format('D, M j');
    }
}

<?php
declare(strict_types=1);

/**
 * The reminder rules, ported from src/schedule.ts (buildReminders and what it
 * uses) so reminder emails list exactly what the in-app bell shows. Pure: it
 * works on the arrays the API returns (Repo::getSchedule, listAccounts,
 * listSubscriptions), with 'YYYY-MM-DD' date strings like the client.
 *
 * Keep the two in step. test/fixtures/reminders/*.json hold cases computed by
 * the TypeScript (src/reminders.golden.test.ts writes and checks them), and
 * test/reminders-parity.php checks this port against the same files.
 */
final class Reminders
{
    /** How many days ahead a due date starts being reminded (REMIND_DAYS). */
    public const REMIND_DAYS = 3;
    /** The planner's lookback (PLAN_LOOKBACK_DAYS), so statuses read the same. */
    private const LOOKBACK_DAYS = 62;
    private const STAGE_ORDER = ['overdue' => 0, 'unlogged' => 1, 'today' => 2, 'soon' => 3];

    /**
     * Everything to remind about on $today, most urgent first; within a day,
     * paydays before outflows, then by name. Each reminder:
     *   key            'stage|itemId|dueDate' ('payday-stage|…' for paydays):
     *                  one per stage, so each stage is emailed once
     *   kind           'due' | 'payday'
     *   stage          'overdue' | 'unlogged' | 'today' | 'soon'
     *   date           the due date, or the payday's expected date
     *   dueDate        the nominal date payments are logged against
     *   itemId, itemKind, name
     *   amountCents    due: this date's amount · payday: the expected salary
     *   paidCents      due: paid so far · payday: received so far
     *   remainingCents what's still owed / still to come in
     *   state          due: paid|partial|overdue|today|upcoming|lapsed ·
     *                  payday: received|today|upcoming|unlogged
     *
     * @param array<string, mixed> $schedule {items, payments, activity}
     * @param list<array<string, mixed>> $accounts
     * @param list<array<string, mixed>> $subscriptions
     * @return list<array<string, mixed>>
     */
    public static function build(array $schedule, array $accounts, array $subscriptions, string $today): array
    {
        $items = self::withSubscriptions($schedule['items'], $subscriptions);
        $ctx = ['accounts' => $accounts, 'subscriptions' => $subscriptions];
        $from = self::addDays($today, -self::LOOKBACK_DAYS);
        $out = [];

        $outflows = [];
        foreach ($items as $item) {
            if ($item['kind'] !== 'income' && !self::chargedToCard($item, $ctx)) {
                array_push($outflows, ...self::itemOccurrences($item, $ctx, $from, self::addDays($today, self::REMIND_DAYS)));
            }
        }
        $statuses = self::dueStatuses($outflows, $schedule, $today);
        foreach ($outflows as $occ) {
            $key = self::occurrenceKey($occ['item']['id'], $occ['dueDate']);
            $status = $statuses[$key] ?? null;
            if ($status === null || $status['state'] === 'paid' || $status['state'] === 'lapsed') {
                continue;
            }
            $stage = $occ['dueDate'] < $today ? 'overdue' : ($occ['dueDate'] === $today ? 'today' : 'soon');
            $out[] = [
                'key' => "$stage|$key",
                'kind' => 'due',
                'stage' => $stage,
                'date' => $occ['dueDate'],
                'dueDate' => $occ['dueDate'],
                'itemId' => $occ['item']['id'],
                'itemKind' => $occ['item']['kind'],
                'name' => $occ['item']['name'],
                'amountCents' => $occ['amountCents'],
                'paidCents' => $status['paidCents'],
                'remainingCents' => $status['remainingCents'],
                'state' => $status['state'],
            ];
        }

        $income = array_values(array_filter($items, static fn(array $i): bool => $i['kind'] === 'income'));
        $paydays = self::allPaydayOccurrences($income, $from, $today);
        $paydayStates = self::paydayStatuses($paydays, $schedule, $today);
        $earliest = self::addDays($today, -self::REMIND_DAYS);
        foreach ($paydays as $p) {
            if ($p['date'] < $earliest) {
                continue;
            }
            $key = self::occurrenceKey($p['item']['id'], $p['dueDate']);
            $status = $paydayStates[$key] ?? null;
            if ($status === null || $status['state'] === 'received') {
                continue;
            }
            $stage = $p['date'] === $today ? 'today' : 'unlogged';
            $out[] = [
                'key' => "payday-$stage|$key",
                'kind' => 'payday',
                'stage' => $stage,
                'date' => $p['date'],
                'dueDate' => $p['dueDate'],
                'itemId' => $p['item']['id'],
                'itemKind' => $p['item']['kind'],
                'name' => $p['item']['name'],
                'amountCents' => $p['item']['amountCents'],
                'paidCents' => $status['receivedCents'],
                'remainingCents' => max(0, $p['item']['amountCents'] - $status['receivedCents']),
                'state' => $status['state'],
            ];
        }

        usort($out, static fn(array $a, array $b): int =>
            (self::STAGE_ORDER[$a['stage']] <=> self::STAGE_ORDER[$b['stage']])
            ?: strcmp($a['date'], $b['date'])
            ?: ($a['kind'] === $b['kind'] ? 0 : ($a['kind'] === 'payday' ? -1 : 1))
            ?: self::compareNames($a['name'], $b['name']));
        return $out;
    }

    // ---------- dates ----------

    private static function day(string $s): DateTimeImmutable
    {
        return new DateTimeImmutable($s, new DateTimeZone('UTC'));
    }

    private static function addDays(string $s, int $n): string
    {
        return self::day($s)->modify(sprintf('%+d days', $n))->format('Y-m-d');
    }

    /** 0 = Sunday .. 6 = Saturday, like Date.getDay(). */
    private static function weekday(string $s): int
    {
        return (int)self::day($s)->format('w');
    }

    /** Day $day of month $m (1-12) in year $y, clamped to the month's length (31st → Feb 28). */
    private static function clampedDate(int $y, int $m, int $day): string
    {
        $last = (int)self::day(sprintf('%04d-%02d-01', $y, $m))->format('t');
        return sprintf('%04d-%02d-%02d', $y, $m, min($day, $last));
    }

    /**
     * [year, month] for each month from $from's through $to's.
     * @return list<array{0: int, 1: int}>
     */
    private static function months(string $from, string $to): array
    {
        [$y, $m] = array_map('intval', explode('-', $from));
        $out = [];
        while (sprintf('%04d-%02d-01', $y, $m) <= $to) {
            $out[] = [$y, $m];
            if (++$m > 12) {
                $m = 1;
                $y++;
            }
        }
        return $out;
    }

    /** A Saturday/Sunday date moved to the Friday before or the Monday after. */
    private static function shiftForWeekend(string $s, string $rule): string
    {
        if ($rule === 'none') {
            return $s;
        }
        $dow = self::weekday($s);
        if ($dow === 6) {
            return self::addDays($s, $rule === 'before' ? -1 : 2);
        }
        if ($dow === 0) {
            return self::addDays($s, $rule === 'before' ? -2 : 1);
        }
        return $s;
    }

    private static function occurrenceKey(int $itemId, string $dueDate): string
    {
        return "$itemId|$dueDate";
    }

    /** Names in the order localeCompare gives (plain case-insensitive without intl). */
    private static function compareNames(string $a, string $b): int
    {
        static $collator = null;
        if ($collator === null && class_exists('Collator')) {
            $collator = new Collator('en_US');
        }
        return $collator !== null ? (int)$collator->compare($a, $b) : strcasecmp($a, $b);
    }

    /**
     * @param list<array<string, mixed>> $rows
     * @return array<string, mixed>|null
     */
    private static function byId(array $rows, mixed $id): ?array
    {
        foreach ($rows as $r) {
            if ($r['id'] === $id) {
                return $r;
            }
        }
        return null;
    }

    // ---------- paydays ----------

    /**
     * A payday's occurrences whose EXPECTED date falls in [$from, $to], limited
     * to nominal dates within the item's startDate..endDate.
     * @return list<array<string, mixed>> {item, dueDate, date}
     */
    private static function paydayOccurrences(array $item, string $from, string $to): array
    {
        if ($item['kind'] !== 'income' || $item['dueDay'] === null || !$item['active']) {
            return [];
        }
        $out = [];
        // A weekend shift moves a date by at most 2 days, so scan a little wider.
        foreach (self::months(self::addDays($from, -3), self::addDays($to, 3)) as [$y, $m]) {
            $dueDate = self::clampedDate($y, $m, $item['dueDay']);
            if ($dueDate < $item['startDate'] || ($item['endDate'] !== null && $dueDate > $item['endDate'])) {
                continue;
            }
            $date = self::shiftForWeekend($dueDate, $item['weekendShift']);
            if ($date < $from || $date > $to) {
                continue;
            }
            $out[] = ['item' => $item, 'dueDate' => $dueDate, 'date' => $date];
        }
        return $out;
    }

    /** @return list<array<string, mixed>> */
    private static function allPaydayOccurrences(array $items, string $from, string $to): array
    {
        $out = [];
        foreach ($items as $item) {
            array_push($out, ...self::paydayOccurrences($item, $from, $to));
        }
        usort($out, static fn(array $a, array $b): int =>
            strcmp($a['date'], $b['date']) ?: $a['item']['id'] <=> $b['item']['id']);
        return $out;
    }

    /**
     * Received = salary logged against the occurrence, plus income transactions
     * in the payday's deposit account (and category, when set) from 3 days
     * before to 5 days after the expected date. Each transaction counts once:
     * rows linked to any payment are skipped, and a matched row is used up,
     * earliest payday first.
     * @return array<string, array{state: string, receivedCents: int}>
     */
    private static function paydayStatuses(array $occurrences, array $data, string $today): array
    {
        $linked = [];
        foreach ($data['payments'] as $p) {
            if ($p['transactionId'] !== null) {
                $linked[$p['transactionId']] = true;
            }
        }
        usort($occurrences, static fn(array $a, array $b): int => strcmp($a['date'], $b['date']));
        $used = [];
        $out = [];
        foreach ($occurrences as $occ) {
            $item = $occ['item'];
            $received = 0;
            foreach ($data['payments'] as $p) {
                if ($p['itemId'] === $item['id'] && $p['dueDate'] === $occ['dueDate']) {
                    $received += $p['amountCents'];
                }
            }
            $lo = self::addDays($occ['date'], -3);
            $hi = self::addDays($occ['date'], 5);
            foreach ($data['activity'] as $a) {
                if (
                    $a['source'] === 'transaction'
                    && $a['type'] === 'income'
                    && !isset($linked[$a['id']])
                    && !isset($used[$a['id']])
                    && $a['accountId'] !== null
                    && $a['accountId'] === $item['accountId']
                    && ($item['categoryId'] === null || $a['categoryId'] === $item['categoryId'])
                    && $a['date'] >= $lo
                    && $a['date'] <= $hi
                ) {
                    $used[$a['id']] = true;
                    $received += $a['amountCents'];
                }
            }
            $state = $received > 0 ? 'received'
                : ($occ['date'] > $today ? 'upcoming' : ($occ['date'] === $today ? 'today' : 'unlogged'));
            $out[self::occurrenceKey($item['id'], $occ['dueDate'])] = ['state' => $state, 'receivedCents' => $received];
        }
        return $out;
    }

    // ---------- scheduled items (outflows) ----------

    /** Monthly due days: a loan/card's come from its account; bills and savings carry their own. */
    private static function monthlyDueDays(array $item, array $accounts): array
    {
        if ($item['kind'] === 'loan' || $item['kind'] === 'card') {
            $a = self::byId($accounts, $item['accountId']);
            return $a === null ? [] : array_values(array_filter(
                [$a['dueDay'], $a['dueDay2']],
                static fn(?int $d): bool => $d !== null
            ));
        }
        if (($item['kind'] === 'bill' || $item['kind'] === 'savings') && $item['dueDay'] !== null) {
            return [$item['dueDay']];
        }
        return [];
    }

    /** Per occurrence: the fixed amount, a bill's 3-month estimate (else its amount), or the subscription's price. */
    private static function occurrenceAmount(array $item, array $ctx): int
    {
        if ($item['kind'] === 'subscription') {
            return self::byId($ctx['subscriptions'], $item['subscriptionId'])['amountCents'] ?? 0;
        }
        if ($item['amountMode'] === 'avg3') {
            return $item['estimateCents'] ?? $item['amountCents'];
        }
        return $item['amountCents'];
    }

    /** One cycle after $date, as Repo::advanceSubDate charges it. */
    private static function nextSubscriptionDate(string $date, array $sub): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', $date));
        if ($sub['cycle'] === 'interval') {
            return self::addDays($date, max(1, $sub['intervalDays'] ?? 1));
        }
        $anchor = $sub['billDay'] ?? $d;
        if ($sub['cycle'] === 'yearly') {
            return self::clampedDate($y + 1, $m, $anchor);
        }
        return $m === 12 ? self::clampedDate($y + 1, 1, $anchor) : self::clampedDate($y, $m + 1, $anchor);
    }

    /**
     * An item's occurrences due within [$from, $to], limited to its
     * startDate..endDate. Subscriptions only look forward from their next
     * charge date — earlier cycles were already charged.
     * @return list<array<string, mixed>> {item, dueDate, amountCents}
     */
    private static function itemOccurrences(array $item, array $ctx, string $from, string $to): array
    {
        if (!$item['active'] || $item['kind'] === 'income') {
            return [];
        }
        $lo = $from < $item['startDate'] ? $item['startDate'] : $from;
        $hi = $item['endDate'] !== null && $item['endDate'] < $to ? $item['endDate'] : $to;
        if ($lo > $hi) {
            return [];
        }
        $amount = self::occurrenceAmount($item, $ctx);
        $out = [];

        if ($item['kind'] === 'allowance') {
            if ($item['weekDay'] === null) {
                return $out;
            }
            for ($d = self::addDays($lo, ($item['weekDay'] - self::weekday($lo) + 7) % 7); $d <= $hi; $d = self::addDays($d, 7)) {
                $out[] = ['item' => $item, 'dueDate' => $d, 'amountCents' => $amount];
            }
            return $out;
        }

        if ($item['kind'] === 'subscription') {
            $sub = self::byId($ctx['subscriptions'], $item['subscriptionId']);
            if ($sub === null || !$sub['active'] || $sub['accountId'] === null) {
                return $out;
            }
            for ($d = $sub['nextDate'], $i = 0; $d <= $hi && $i < 1000; $d = self::nextSubscriptionDate($d, $sub), $i++) {
                if ($d >= $lo) {
                    $out[] = ['item' => $item, 'dueDate' => $d, 'amountCents' => $amount];
                }
            }
            return $out;
        }

        $days = self::monthlyDueDays($item, $ctx['accounts']);
        foreach (self::months($lo, $hi) as [$y, $m]) {
            // Two due days can clamp to the same date (30th + 31st in February).
            $dates = array_unique(array_map(static fn(int $day): string => self::clampedDate($y, $m, $day), $days));
            sort($dates);
            foreach ($dates as $d) {
                if ($d >= $lo && $d <= $hi) {
                    $out[] = ['item' => $item, 'dueDate' => $d, 'amountCents' => $amount];
                }
            }
        }
        return $out;
    }

    /** Subscriptions charged to a credit card don't leave cash directly — the card's payment covers them. */
    private static function chargedToCard(array $item, array $ctx): bool
    {
        if ($item['kind'] !== 'subscription') {
            return false;
        }
        $sub = self::byId($ctx['subscriptions'], $item['subscriptionId']);
        $account = $sub === null ? null : self::byId($ctx['accounts'], $sub['accountId']);
        return $account !== null && $account['type'] === 'credit';
    }

    /**
     * The saved items plus a stand-in (negative id) for each subscription with
     * no schedule row yet: subscriptions are always on the schedule.
     * @return list<array<string, mixed>>
     */
    private static function withSubscriptions(array $items, array $subscriptions): array
    {
        $covered = [];
        foreach ($items as $i) {
            if ($i['subscriptionId'] !== null) {
                $covered[$i['subscriptionId']] = true;
            }
        }
        foreach ($subscriptions as $s) {
            if (isset($covered[$s['id']])) {
                continue;
            }
            $items[] = [
                'id' => -$s['id'],
                'name' => $s['name'],
                'kind' => 'subscription',
                'accountId' => null,
                'subscriptionId' => $s['id'],
                'categoryId' => null,
                'amountMode' => 'fixed',
                'amountCents' => 0,
                'matchKeyword' => null,
                'dueDay' => null,
                'weekDay' => null,
                'fundedBy' => null,
                'weekendShift' => 'none',
                'startDate' => '1970-01-01',
                'endDate' => null,
                'active' => true,
                'estimateCents' => null,
            ];
        }
        return array_values($items);
    }

    private static function hasKeyword(array $item): bool
    {
        return $item['matchKeyword'] !== null && $item['matchKeyword'] !== '';
    }

    /**
     * A ledger row not paid through the Schedule that can still settle an
     * item: a payment INTO its loan/card/savings account, or an expense in a
     * bill's category (with its keyword, when it has one). Allowances only
     * count what's paid through the Schedule.
     */
    private static function activityMatches(array $item, array $a): bool
    {
        if (in_array($item['kind'], ['loan', 'card', 'savings'], true)) {
            return $a['source'] === 'transfer' && $a['accountId'] !== null && $a['accountId'] === $item['accountId'];
        }
        if ($item['kind'] === 'bill') {
            return $a['source'] === 'transaction'
                && $a['type'] === 'expense'
                && $a['categoryId'] !== null
                && $a['categoryId'] === $item['categoryId']
                && (!self::hasKeyword($item)
                    || str_contains(mb_strtolower($a['note']), mb_strtolower($item['matchKeyword'])));
        }
        return false;
    }

    /**
     * Paid / partial / overdue for each occurrence. Schedule payments count
     * for their own due date. Other matching payments settle the item's
     * EARLIEST unpaid due date from 45 days before to 31 days after the
     * payment, never one dated before the item started, each payment once —
     * bills with a keyword picking theirs first.
     * @return array<string, array{state: string, paidCents: int, remainingCents: int}>
     */
    private static function dueStatuses(array $occurrences, array $data, string $today): array
    {
        $linkedTransfers = [];
        $linkedTx = [];
        foreach ($data['payments'] as $p) {
            if ($p['transferId'] !== null) {
                $linkedTransfers[$p['transferId']] = true;
            }
            if ($p['transactionId'] !== null) {
                $linkedTx[$p['transactionId']] = true;
            }
        }
        $unlinked = array_values(array_filter(
            $data['activity'],
            static fn(array $a): bool => !isset(($a['source'] === 'transfer' ? $linkedTransfers : $linkedTx)[$a['id']])
        ));
        usort($unlinked, static fn(array $a, array $b): int => strcmp($a['date'], $b['date']) ?: $a['id'] <=> $b['id']);

        $paid = [];
        $byItem = [];
        foreach ($occurrences as $occ) {
            $own = 0;
            foreach ($data['payments'] as $p) {
                if ($p['itemId'] === $occ['item']['id'] && $p['dueDate'] === $occ['dueDate']) {
                    $own += $p['amountCents'];
                }
            }
            $paid[self::occurrenceKey($occ['item']['id'], $occ['dueDate'])] = $own;
            $byItem[$occ['item']['id']][] = $occ;
        }

        $lists = array_values($byItem);
        usort($lists, static fn(array $a, array $b): int =>
            (int)!self::hasKeyword($a[0]['item']) <=> (int)!self::hasKeyword($b[0]['item']));
        $used = [];
        foreach ($lists as $list) {
            usort($list, static fn(array $a, array $b): int => strcmp($a['dueDate'], $b['dueDate']));
            $item = $list[0]['item'];
            foreach ($unlinked as $row) {
                $rowKey = $row['source'] . ':' . $row['id'];
                if (isset($used[$rowKey]) || $row['date'] < $item['startDate'] || !self::activityMatches($item, $row)) {
                    continue;
                }
                $lo = self::addDays($row['date'], -45);
                $hi = self::addDays($row['date'], 31);
                foreach ($list as $o) {
                    $k = self::occurrenceKey($o['item']['id'], $o['dueDate']);
                    if ($o['dueDate'] >= $lo && $o['dueDate'] <= $hi && $paid[$k] < $o['amountCents']) {
                        $used[$rowKey] = true;
                        $paid[$k] += $row['amountCents'];
                        break;
                    }
                }
            }
        }

        $out = [];
        foreach ($occurrences as $occ) {
            $key = self::occurrenceKey($occ['item']['id'], $occ['dueDate']);
            $paidCents = $paid[$key];
            $remaining = max(0, $occ['amountCents'] - $paidCents);
            // A bill with no estimate yet (amount 0) is only "paid" once something is paid.
            $state = $paidCents > 0 && $remaining === 0 ? 'paid'
                : ($occ['item']['kind'] === 'allowance' && $occ['dueDate'] < $today ? 'lapsed'
                : ($paidCents > 0 ? 'partial'
                : ($occ['dueDate'] < $today ? 'overdue'
                : ($occ['dueDate'] === $today ? 'today' : 'upcoming'))));
            $out[$key] = ['state' => $state, 'paidCents' => $paidCents, 'remainingCents' => $remaining];
        }
        return $out;
    }
}

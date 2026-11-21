<?php
declare(strict_types=1);

final class Validate
{
    public static function month(mixed $m): string
    {
        if (!is_string($m) || !preg_match('/^\d{4}-\d{2}$/', $m)) {
            throw new ApiError('Invalid month', 422);
        }
        $mm = (int)substr($m, 5, 2);
        if ($mm < 1 || $mm > 12) {
            throw new ApiError('Invalid month', 422);
        }
        return $m;
    }

    public static function date(mixed $d): string
    {
        if (!is_string($d) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $x)) {
            throw new ApiError('Invalid date', 422);
        }
        if (!checkdate((int)$x[2], (int)$x[3], (int)$x[1])) {
            throw new ApiError('Invalid date', 422);
        }
        return $d;
    }

    /** Optional time-of-day: null/'' -> null, otherwise strict 24h HH:MM. */
    public static function timeHmOrNull(mixed $t): ?string
    {
        if ($t === null || $t === '') {
            return null;
        }
        if (!is_string($t) || !preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $t)) {
            throw new ApiError('Invalid time', 422);
        }
        return $t;
    }

    public static function type(mixed $t): string
    {
        if ($t !== 'income' && $t !== 'expense') {
            throw new ApiError('Invalid type', 422);
        }
        return $t;
    }

    public static function color(mixed $c): string
    {
        if (!is_string($c) || !preg_match('/^#[0-9a-fA-F]{6}$/', $c)) {
            throw new ApiError('Invalid color', 422);
        }
        return $c;
    }

    public static function name(mixed $n): string
    {
        $n = trim((string)(is_scalar($n) ? $n : ''));
        if ($n === '') {
            throw new ApiError('Name is required', 422);
        }
        if (mb_strlen($n) > 60) {
            throw new ApiError('Name is too long (max 60 characters)', 422);
        }
        return $n;
    }

    public static function amountCents(mixed $v, bool $allowZero = false): int
    {
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v)) {
            throw new ApiError('Amount must be a whole number of cents', 422);
        }
        if (($v < 0) || (!$allowZero && $v === 0) || $v > 100000000000) {
            throw new ApiError('Amount must be a positive number', 422);
        }
        return $v;
    }

    public static function note(mixed $n): string
    {
        $n = (string)(is_scalar($n) ? $n : '');
        return mb_strlen($n) > 500 ? mb_substr($n, 0, 500) : $n;
    }

    public static function email(mixed $e): string
    {
        $e = strtolower(trim((string)(is_scalar($e) ? $e : '')));
        if ($e === '' || strlen($e) > 190 || !filter_var($e, FILTER_VALIDATE_EMAIL)) {
            throw new ApiError('Invalid email address', 422);
        }
        return $e;
    }

    public static function intId(mixed $v): int
    {
        if (is_string($v) && ctype_digit($v)) {
            $v = (int)$v;
        }
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v <= 0) {
            throw new ApiError('Invalid id', 422);
        }
        return $v;
    }

    public static function categoryIdOrNull(mixed $v): ?int
    {
        if ($v === null) {
            return null;
        }
        return self::intId($v);
    }

    public static function accountIdOrNull(mixed $v): ?int
    {
        if ($v === null) {
            return null;
        }
        return self::intId($v);
    }

    public static function accountType(mixed $t): string
    {
        if ($t !== 'debit' && $t !== 'credit' && $t !== 'loan') {
            throw new ApiError('Invalid account type', 422);
        }
        return $t;
    }

    /** Monthly payment due day for credit/loan accounts: null or 1–31. */
    public static function dueDayOrNull(mixed $v): ?int
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (is_string($v) && ctype_digit($v)) {
            $v = (int)$v;
        }
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v < 1 || $v > 31) {
            throw new ApiError('Due day must be between 1 and 31', 422);
        }
        return $v;
    }

    /** Statement closing day for credit cards: null or 1–31. */
    public static function statementDayOrNull(mixed $v): ?int
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (is_string($v) && ctype_digit($v)) {
            $v = (int)$v;
        }
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v < 1 || $v > 31) {
            throw new ApiError('Statement day must be between 1 and 31', 422);
        }
        return $v;
    }

    /** Optional positive amount in cents (a credit limit): null/'' -> null. */
    public static function amountCentsOrNull(mixed $v): ?int
    {
        if ($v === null || $v === '') {
            return null;
        }
        return self::amountCents($v);
    }

    /**
     * Yearly interest rate in basis points (3600 = 36% a year): null, '' and 0
     * all mean "no interest" and are stored as null. Capped at 1000% a year.
     */
    public static function interestRateBpOrNull(mixed $v): ?int
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v < 0 || $v > 100000) {
            throw new ApiError('Interest rate must be between 0% and 1000% a year', 422);
        }
        return $v === 0 ? null : $v;
    }

    /** A JSON true/false switch (no truthy strings or numbers). */
    public static function boolean(mixed $v, string $what = 'Value'): bool
    {
        if (!is_bool($v)) {
            throw new ApiError("$what must be true or false", 422);
        }
        return $v;
    }

    /** Budget cadence: the recurring period a budget amount applies to. */
    public static function cadence(mixed $c): string
    {
        if ($c !== 'week' && $c !== 'month' && $c !== 'year') {
            throw new ApiError('Invalid cadence', 422);
        }
        return $c;
    }

    /** Subscription billing cycle: same date monthly/yearly, or every N days. */
    public static function subCycle(mixed $c): string
    {
        if ($c !== 'monthly' && $c !== 'interval' && $c !== 'yearly') {
            throw new ApiError('Invalid billing cycle', 422);
        }
        return $c;
    }

    /** Days between charges for every-N-days subscriptions (1–365). */
    public static function intervalDays(mixed $v): int
    {
        if (is_string($v) && ctype_digit($v)) {
            $v = (int)$v;
        }
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v < 1 || $v > 365) {
            throw new ApiError('Days between charges must be between 1 and 365', 422);
        }
        return $v;
    }

    /** Optional date: null/'' -> null, otherwise a strict YYYY-MM-DD. */
    public static function dateOrNull(mixed $d): ?string
    {
        if ($d === null || $d === '') {
            return null;
        }
        return self::date($d);
    }

    /** What a payment-schedule row represents (see schedule_items). */
    public static function scheduleKind(mixed $k): string
    {
        $kinds = ['income', 'loan', 'card', 'bill', 'allowance', 'savings', 'subscription'];
        if (!is_string($k) || !in_array($k, $kinds, true)) {
            throw new ApiError('Invalid schedule item kind', 422);
        }
        return $k;
    }

    /** Schedule amount: a fixed figure, or (bills) the last-3-months average. */
    public static function scheduleAmountMode(mixed $m): string
    {
        if ($m !== 'fixed' && $m !== 'avg3') {
            throw new ApiError('Invalid amount mode', 422);
        }
        return $m;
    }

    /** Where a payday that lands on a weekend moves to. */
    public static function weekendShift(mixed $s): string
    {
        if ($s !== 'none' && $s !== 'before' && $s !== 'after') {
            throw new ApiError('Invalid weekend rule', 422);
        }
        return $s;
    }

    /** Day of the week for weekly items: 0 = Sunday .. 6 = Saturday. */
    public static function weekDay(mixed $v): int
    {
        if (is_string($v) && ctype_digit($v)) {
            $v = (int)$v;
        }
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v < 0 || $v > 6) {
            throw new ApiError('Day of the week must be between 0 (Sunday) and 6 (Saturday)', 422);
        }
        return $v;
    }

    /**
     * Savings milestones: up to 8 positive amounts in cents, returned sorted
     * ascending without duplicates. null/'' -> [] (none).
     * @return list<int>
     */
    public static function milestones(mixed $v): array
    {
        if ($v === null || $v === '') {
            return [];
        }
        if (!is_array($v) || count($v) > 8) {
            throw new ApiError('Use up to 8 milestones', 422);
        }
        $out = array_values(array_unique(array_map(static fn($m): int => self::amountCents($m), array_values($v))));
        sort($out);
        return $out;
    }

    /** Optional note filter for bill estimates: null/blank -> null, max 60 chars. */
    public static function keywordOrNull(mixed $k): ?string
    {
        $k = trim((string)(is_scalar($k) ? $k : ''));
        if ($k === '') {
            return null;
        }
        if (mb_strlen($k) > 60) {
            throw new ApiError('Keyword is too long (max 60 characters)', 422);
        }
        return $k;
    }

    /**
     * Optional custom account image, stored inline as a base64 data URI.
     * null / '' means "no image" (the account falls back to its color).
     * We only accept image data URIs, cap the size, and confirm the base64
     * actually decodes so a junk string can't be stored. The client already
     * downscales to a small square, so this is a safety ceiling, not the
     * expected size (~<100KB in practice).
     */
    public static function accountImage(mixed $v): ?string
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (!is_string($v)) {
            throw new ApiError('Invalid image', 422);
        }
        // Byte length (data URIs are ASCII); keep below the accounts route's
        // JSON body cap so the rest of the payload still fits.
        if (strlen($v) > 800000) {
            throw new ApiError('Image is too large', 422);
        }
        if (!preg_match('#^data:image/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$#', $v, $m)) {
            throw new ApiError('Invalid image', 422);
        }
        $decoded = base64_decode($m[1], true);
        if ($decoded === false || $decoded === '') {
            throw new ApiError('Invalid image', 422);
        }
        return $v;
    }

    /** Signed cents (opening balances may be negative = money owed). */
    public static function signedCents(mixed $v): int
    {
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v) || $v < -100000000000 || $v > 100000000000) {
            throw new ApiError('Amount must be a whole number of cents', 422);
        }
        return $v;
    }

    /** Transfer fee: zero or positive cents. */
    public static function feeCents(mixed $v): int
    {
        if ($v === null || $v === '') {
            return 0;
        }
        return self::amountCents($v, true);
    }

    /**
     * A card adjustment: signed like a balance (+ lowers what's owed, − adds
     * to it), never zero, at most a billion either way.
     */
    public static function adjustmentCents(mixed $v): int
    {
        if (is_float($v) && floor($v) === $v) {
            $v = (int)$v;
        }
        if (!is_int($v)) {
            throw new ApiError('Amount must be a whole number of cents', 422);
        }
        if ($v === 0 || $v < -100000000000 || $v > 100000000000) {
            throw new ApiError('Enter an amount for the adjustment', 422);
        }
        return $v;
    }

    /** Why a card balance was adjusted. */
    public static function adjustmentReason(mixed $r): string
    {
        if (!is_string($r) || !in_array($r, ['points', 'refund', 'fee', 'other'], true)) {
            throw new ApiError('Reason must be points, refund, fee or other', 422);
        }
        return $r;
    }

    /**
     * ISO-4217-style 3-letter currency code, uppercased. We only enforce the
     * format; the frontend restricts the actual choices and falls back to a
     * plain code if a formatter doesn't recognise it.
     */
    public static function currency(mixed $c): string
    {
        $c = strtoupper(trim((string)(is_scalar($c) ? $c : '')));
        if (!preg_match('/^[A-Z]{3}$/', $c)) {
            throw new ApiError('Invalid currency code', 422);
        }
        return $c;
    }

    /** An IANA time zone name as browsers report it (e.g. 'Asia/Manila'). */
    public static function timezone(mixed $tz): string
    {
        $tz = is_string($tz) ? trim($tz) : '';
        // ALL_WITH_BC also accepts older aliases some browsers still report
        // (e.g. 'Asia/Calcutta').
        if ($tz === '' || !in_array($tz, DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC), true)) {
            throw new ApiError('Unknown time zone', 422);
        }
        return $tz;
    }
}

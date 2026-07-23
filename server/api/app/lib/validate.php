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
}

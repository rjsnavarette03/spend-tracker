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

<?php
declare(strict_types=1);

final class ApiError extends Exception
{
    public int $status;

    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

final class Http
{
    /** @var array<string, mixed> */
    private static array $config = [];

    /** @param array<string, mixed> $config */
    public static function init(array $config): void
    {
        self::$config = $config;
        ini_set('display_errors', '0');
        header_remove('X-Powered-By');

        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

        session_name((string)($config['session_name'] ?? 'spendtracker_sid'));
        session_set_cookie_params([
            'lifetime' => 60 * 60 * 24 * 30,
            'path' => '/',
            'domain' => '',
            'secure' => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();

        if (empty($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
    }

    public static function config(string $key, mixed $default = null): mixed
    {
        return self::$config[$key] ?? $default;
    }

    public static function json(mixed $data, int $status = 200): never
    {
        if (ob_get_level() > 0) {
            ob_clean();
        }
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    /** @return array<string, mixed> */
    public static function readJson(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false || strlen($raw) > 64 * 1024) {
            throw new ApiError('Invalid request body', 400);
        }
        $data = json_decode($raw === '' ? 'null' : $raw, true);
        if (!is_array($data)) {
            throw new ApiError('Invalid JSON body', 400);
        }
        return $data;
    }

    public static function csrfCheck(): void
    {
        $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        $expected = $_SESSION['csrf'] ?? '';
        if (!is_string($token) || $token === '' || !is_string($expected) || !hash_equals($expected, $token)) {
            throw new ApiError('Invalid or missing CSRF token', 403);
        }
    }

    /**
     * Reject cross-origin mutations. Primary signal is Sec-Fetch-Site, which
     * every modern browser sends and page script cannot forge; it catches the
     * Origin:null sandboxed-iframe case that a bare Origin check misses.
     * Falls back to an Origin host match for older browsers.
     *
     * $strict is used for the pre-auth routes (login/register/google) which
     * carry no CSRF token: when neither signal is present we cannot confirm
     * same-origin, so we reject rather than risk login/registration CSRF.
     * Authenticated routes (non-strict) are still covered by the CSRF token.
     */
    public static function originCheck(string $method, bool $strict = false): void
    {
        if ($method === 'GET' || $method === 'HEAD' || $method === 'OPTIONS') {
            return;
        }

        $sfs = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
        if (is_string($sfs) && $sfs !== '') {
            if ($sfs === 'same-origin' || $sfs === 'same-site') {
                return;
            }
            throw new ApiError('Cross-origin request rejected', 403);
        }

        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (is_string($origin) && $origin !== '' && $origin !== 'null') {
            $originHost = strtolower((string)parse_url($origin, PHP_URL_HOST));
            $selfHost = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '') ?? '');
            $loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
            if (in_array($originHost, $loopback, true) && in_array($selfHost, $loopback, true)) {
                return;
            }
            if ($originHost !== '' && $originHost === $selfHost) {
                return;
            }
            throw new ApiError('Cross-origin request rejected', 403);
        }

        // No Sec-Fetch-Site and no usable Origin: a modern browser always
        // sends at least one, so this is a direct (non-browser) client.
        if ($strict) {
            throw new ApiError('Cross-origin request rejected', 403);
        }
    }

    public static function clientIp(): string
    {
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    /**
     * Fixed-window rate limiter backed by the auth_throttle table.
     * Counts the attempt first, so failures cannot bypass it.
     */
    public static function throttle(string $key, int $maxAttempts, int $windowSec): void
    {
        $key = substr($key, 0, 190);
        $now = time();
        $row = DB::one('SELECT attempts, window_start FROM auth_throttle WHERE tkey = ?', [$key]);
        if ($row !== null && ($now - (int)$row['window_start']) < $windowSec) {
            if ((int)$row['attempts'] >= $maxAttempts) {
                throw new ApiError('Too many attempts. Please try again later.', 429);
            }
            DB::exec('UPDATE auth_throttle SET attempts = attempts + 1 WHERE tkey = ?', [$key]);
        } elseif ($row !== null) {
            DB::exec('UPDATE auth_throttle SET attempts = 1, window_start = ? WHERE tkey = ?', [$now, $key]);
        } else {
            DB::exec('INSERT INTO auth_throttle (tkey, attempts, window_start) VALUES (?, 1, ?)', [$key, $now]);
        }
    }

    public static function throttleClear(string $key): void
    {
        DB::exec('DELETE FROM auth_throttle WHERE tkey = ?', [substr($key, 0, 190)]);
    }
}

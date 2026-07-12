<?php
declare(strict_types=1);

final class Auth
{
    /** How long an emailed verification code / backup link stays valid. */
    private const VERIFY_TTL = 1800; // 30 minutes
    /** Wrong-code guesses allowed before a code is burned (resend required). */
    private const MAX_CODE_ATTEMPTS = 6;

    public static function requireUser(): int
    {
        $uid = $_SESSION['uid'] ?? null;
        if (!is_int($uid) || $uid <= 0) {
            throw new ApiError('Not signed in', 401);
        }
        return $uid;
    }

    /**
     * Like requireUser(), but also refuses users whose email isn't verified.
     * Gates every data endpoint so an unverified account can sign in (to reach
     * the verify screen) but can't read or write any data. The email_verified
     * column is read fresh each call so verifying in another tab/device takes
     * effect immediately; the array_key_exists guard keeps users usable during
     * the brief window before the column migrates in.
     */
    public static function requireVerifiedUser(): int
    {
        $uid = self::requireUser();
        $u = DB::one('SELECT email_verified FROM users WHERE id = ?', [$uid]);
        if ($u !== null && array_key_exists('email_verified', $u) && (int)$u['email_verified'] !== 1) {
            throw new ApiError('Please verify your email address to continue.', 403);
        }
        return $uid;
    }

    /** @return array<string, mixed>|null */
    public static function currentUser(): ?array
    {
        $uid = $_SESSION['uid'] ?? null;
        if (!is_int($uid) || $uid <= 0) {
            return null;
        }
        $u = DB::one('SELECT id, email, name, password_hash, google_sub, currency, email_verified FROM users WHERE id = ?', [$uid]);
        if ($u === null) {
            unset($_SESSION['uid']);
            return null;
        }
        return self::publicUser($u);
    }

    /**
     * @param array<string, mixed> $u
     * @return array<string, mixed>
     */
    private static function publicUser(array $u): array
    {
        return [
            'id' => (int)$u['id'],
            'email' => (string)$u['email'],
            'name' => (string)$u['name'],
            'hasPassword' => $u['password_hash'] !== null,
            'hasGoogle' => $u['google_sub'] !== null,
            // Fallback covers the brief window before the currency column migrates.
            'currency' => strtoupper((string)($u['currency'] ?? 'USD')) ?: 'USD',
            // Fallback true (verified) if the column hasn't migrated in yet, so
            // nobody is locked out mid-deploy.
            'emailVerified' => !array_key_exists('email_verified', $u) || (int)$u['email_verified'] === 1,
        ];
    }

    public static function setCurrency(int $uid, mixed $currency): string
    {
        $currency = Validate::currency($currency);
        DB::exec('UPDATE users SET currency = ? WHERE id = ?', [$currency, $uid]);
        return $currency;
    }

    /**
     * Sanitize the client's region-detected currency HINT sent with signup.
     * Unlike Validate::currency this never throws — a bad or missing hint
     * must not block a registration — it just falls back to USD.
     */
    private static function currencyHint(mixed $raw): string
    {
        return is_string($raw) && preg_match('/^[A-Za-z]{3}$/', $raw) === 1
            ? strtoupper($raw)
            : 'USD';
    }

    private static function establishSession(int $userId): void
    {
        session_regenerate_id(true);
        $_SESSION['uid'] = $userId;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    /** @return array<string, mixed> */
    public static function register(mixed $email, mixed $password, mixed $name, mixed $currency = null): array
    {
        Http::throttle('register:' . Http::clientIp(), 20, 3600);

        $email = Validate::email($email);
        $password = is_string($password) ? $password : '';
        if (strlen($password) < 8 || strlen($password) > 200) {
            throw new ApiError('Password must be at least 8 characters', 422);
        }
        $name = trim((string)(is_scalar($name) ? $name : ''));
        if (mb_strlen($name) > 100) {
            $name = mb_substr($name, 0, 100);
        }

        if (DB::one('SELECT id FROM users WHERE email = ?', [$email]) !== null) {
            throw new ApiError('An account with this email already exists', 409);
        }

        $hash = password_hash($password, PASSWORD_DEFAULT);
        // email_verified = 0: new email/password accounts must verify. (The
        // column DEFAULTs to 1, so this explicit 0 is what gates them.)
        $uid = DB::insert(
            'INSERT INTO users (email, password_hash, name, email_verified, currency) VALUES (?, ?, ?, 0, ?)',
            [$email, $hash, $name, self::currencyHint($currency)]
        );
        Repo::seedDefaultCategories($uid);
        self::issueEmailVerification($uid, $email);
        self::establishSession($uid);
        $user = self::currentUser();
        assert($user !== null);
        return $user;
    }

    /** @return array<string, mixed> */
    public static function login(mixed $email, mixed $password): array
    {
        $email = Validate::email($email);
        $password = is_string($password) ? $password : '';
        // Two throttles: per (IP, email) stops a single host hammering, and
        // per account caps total failures across a proxy pool / botnet.
        $ipKey = 'login:' . Http::clientIp() . ':' . $email;
        $acctKey = 'login_acct:' . $email;
        Http::throttle($ipKey, 8, 600);
        Http::throttle($acctKey, 50, 900);

        $u = DB::one('SELECT * FROM users WHERE email = ?', [$email]);
        if ($u !== null && $u['password_hash'] === null && $u['google_sub'] !== null) {
            throw new ApiError('This account uses Google sign-in — use the Google button instead.', 401);
        }
        if ($u === null || $u['password_hash'] === null || !password_verify($password, (string)$u['password_hash'])) {
            throw new ApiError('Incorrect email or password', 401);
        }

        Http::throttleClear($ipKey);
        Http::throttleClear($acctKey);
        self::establishSession((int)$u['id']);
        return self::publicUser($u);
    }

    /** @return array<string, mixed> */
    public static function googleSignIn(mixed $credential, string $clientId, mixed $currency = null): array
    {
        if ($clientId === '') {
            throw new ApiError('Google sign-in is not configured on this server', 400);
        }
        if (!is_string($credential) || $credential === '' || strlen($credential) > 8192) {
            throw new ApiError('Invalid Google credential', 400);
        }
        Http::throttle('google:' . Http::clientIp(), 30, 600);

        $claims = self::verifyGoogleToken($credential, $clientId);
        $sub = (string)$claims['sub'];
        $email = Validate::email($claims['email']);
        $name = mb_substr((string)($claims['name'] ?? ''), 0, 100);

        $u = DB::one('SELECT * FROM users WHERE google_sub = ?', [$sub]);
        if ($u === null) {
            $byEmail = DB::one('SELECT * FROM users WHERE email = ?', [$email]);
            if ($byEmail !== null) {
                // Same verified email — link Google to the existing account.
                // Google has confirmed the address, so mark it verified too.
                DB::exec('UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ?', [$sub, (int)$byEmail['id']]);
                $u = DB::one('SELECT * FROM users WHERE id = ?', [(int)$byEmail['id']]);
            } else {
                // First Google sign-in creates the account, so the region
                // hint applies here too. Existing accounts keep their choice.
                $uid = DB::insert(
                    'INSERT INTO users (email, google_sub, name, currency) VALUES (?, ?, ?, ?)',
                    [$email, $sub, $name, self::currencyHint($currency)]
                );
                Repo::seedDefaultCategories($uid);
                $u = DB::one('SELECT * FROM users WHERE id = ?', [$uid]);
            }
        }
        assert($u !== null);
        self::establishSession((int)$u['id']);
        return self::publicUser($u);
    }

    /**
     * Verify a Google ID token via Google's tokeninfo endpoint (TLS-pinned
     * by the system CA store). Checks audience, issuer, expiry and that
     * the email is verified.
     *
     * @return array<string, mixed>
     */
    private static function verifyGoogleToken(string $credential, string $clientId): array
    {
        $ch = curl_init('https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($credential));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if (!is_string($body) || $status !== 200) {
            throw new ApiError('Could not verify Google sign-in', 401);
        }
        $claims = json_decode($body, true);
        if (!is_array($claims)) {
            throw new ApiError('Could not verify Google sign-in', 401);
        }
        if (($claims['aud'] ?? '') !== $clientId) {
            throw new ApiError('Google sign-in was issued for a different app', 401);
        }
        if (!in_array($claims['iss'] ?? '', ['accounts.google.com', 'https://accounts.google.com'], true)) {
            throw new ApiError('Could not verify Google sign-in', 401);
        }
        if ((int)($claims['exp'] ?? 0) < time()) {
            throw new ApiError('Google sign-in expired — try again', 401);
        }
        $verified = $claims['email_verified'] ?? false;
        if ($verified !== true && $verified !== 'true') {
            throw new ApiError('Your Google email address is not verified', 401);
        }
        if (empty($claims['sub']) || empty($claims['email'])) {
            throw new ApiError('Could not verify Google sign-in', 401);
        }
        return $claims;
    }

    private static function validatePassword(mixed $password): string
    {
        $password = is_string($password) ? $password : '';
        if (strlen($password) < 8 || strlen($password) > 200) {
            throw new ApiError('Password must be at least 8 characters', 422);
        }
        return $password;
    }

    /**
     * Change the signed-in user's password. If the account already has a
     * password, the current one must be supplied and verified. Google-only
     * accounts (no password yet) can set one without a current password —
     * they are already authenticated by their session.
     */
    public static function changePassword(int $uid, mixed $currentPassword, mixed $newPassword): void
    {
        $newPassword = self::validatePassword($newPassword);
        $u = DB::one('SELECT id, password_hash FROM users WHERE id = ?', [$uid]);
        if ($u === null) {
            throw new ApiError('Not signed in', 401);
        }
        if ($u['password_hash'] !== null) {
            $current = is_string($currentPassword) ? $currentPassword : '';
            if ($current === '' || !password_verify($current, (string)$u['password_hash'])) {
                throw new ApiError('Current password is incorrect', 403);
            }
        }
        $hash = password_hash($newPassword, PASSWORD_DEFAULT);
        DB::exec('UPDATE users SET password_hash = ? WHERE id = ?', [$hash, $uid]);
        // Invalidate any outstanding reset tokens and rotate the session.
        DB::exec('DELETE FROM password_resets WHERE user_id = ?', [$uid]);
        session_regenerate_id(true);
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    /**
     * Begin a password reset: email a one-time link if the account exists.
     * Always succeeds from the caller's view so email addresses can't be
     * enumerated. Tokens are stored only as a SHA-256 hash.
     */
    public static function forgotPassword(mixed $email): void
    {
        $email = Validate::email($email);
        // Rate-limit per IP and per account regardless of existence.
        Http::throttle('forgot:' . Http::clientIp(), 10, 900);
        Http::throttle('forgot_acct:' . $email, 5, 900);

        $u = DB::one('SELECT id, email FROM users WHERE email = ?', [$email]);
        if ($u !== null) {
            $uid = (int)$u['id'];
            // One active token per user: clear old ones first.
            DB::exec('DELETE FROM password_resets WHERE user_id = ?', [$uid]);
            $token = bin2hex(random_bytes(32));
            $hash = hash('sha256', $token);
            $expires = time() + 3600; // 1 hour
            DB::exec(
                'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
                [$uid, $hash, $expires]
            );
            $link = Mailer::appBaseUrl() . '/?reset=' . $token;
            $body = "Hello,\n\n"
                . "We received a request to reset your SpendTracker password. "
                . "Click the link below to choose a new one. This link expires in 1 hour "
                . "and can be used once.\n\n"
                . $link . "\n\n"
                . "If you didn't request this, you can safely ignore this email — "
                . "your password won't change.\n\n"
                . "— SpendTracker";
            Mailer::send((string)$u['email'], 'Reset your SpendTracker password', $body);
        }
    }

    /**
     * Complete a password reset with a token from the emailed link. On success
     * the user is signed in and a public user record is returned.
     *
     * @return array<string, mixed>
     */
    public static function resetPassword(mixed $token, mixed $newPassword): array
    {
        Http::throttle('reset:' . Http::clientIp(), 20, 900);
        $token = is_string($token) ? $token : '';
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
            throw new ApiError('Invalid or expired reset link', 400);
        }
        $newPassword = self::validatePassword($newPassword);

        $hash = hash('sha256', $token);
        $row = DB::one('SELECT id, user_id, expires_at FROM password_resets WHERE token_hash = ?', [$hash]);
        if ($row === null || (int)$row['expires_at'] < time()) {
            if ($row !== null) {
                DB::exec('DELETE FROM password_resets WHERE id = ?', [(int)$row['id']]);
            }
            throw new ApiError('This reset link has expired. Please request a new one.', 400);
        }

        $uid = (int)$row['user_id'];
        $pwHash = password_hash($newPassword, PASSWORD_DEFAULT);
        // Completing a reset proves control of the mailbox, so also mark the
        // email verified and clear any pending verification for this user.
        DB::exec('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', [$pwHash, $uid]);
        DB::exec('DELETE FROM password_resets WHERE user_id = ?', [$uid]);
        DB::exec('DELETE FROM email_verifications WHERE user_id = ?', [$uid]);

        $u = DB::one('SELECT id, email, name, password_hash, google_sub, currency, email_verified FROM users WHERE id = ?', [$uid]);
        assert($u !== null);
        // A successful reset proves control of the mailbox — clear login locks.
        Http::throttleClear('login_acct:' . (string)$u['email']);
        self::establishSession($uid);
        return self::publicUser($u);
    }

    /**
     * Create (or replace) the pending email verification for a user and email
     * them both a 6-digit code (typed into the app) and a one-click backup
     * link. Only hashes are stored; the plaintext exists only in the email.
     */
    private static function issueEmailVerification(int $uid, string $email): void
    {
        DB::exec('DELETE FROM email_verifications WHERE user_id = ?', [$uid]);
        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $token = bin2hex(random_bytes(32));
        $expires = time() + self::VERIFY_TTL;
        DB::exec(
            'INSERT INTO email_verifications (user_id, code_hash, token_hash, attempts, expires_at) VALUES (?, ?, ?, 0, ?)',
            [$uid, hash('sha256', $code), hash('sha256', $token), $expires]
        );

        $link = Mailer::appBaseUrl() . '/?verify=' . $token;
        $mins = (int)round(self::VERIFY_TTL / 60);
        $body = "Hello,\n\n"
            . "Welcome to SpendTracker! Confirm your email address to finish setting up your account.\n\n"
            . "Your verification code is:\n\n"
            . "    " . $code . "\n\n"
            . "Enter this code in the app to verify your account. It expires in {$mins} minutes.\n\n"
            . "Prefer one click? You can also verify by opening this link (it signs you in and "
            . "expires in {$mins} minutes):\n\n"
            . $link . "\n\n"
            . "If you didn't create a SpendTracker account, you can safely ignore this email.\n\n"
            . "For your security, never share this code with anyone — SpendTracker staff will never "
            . "ask for it.\n\n"
            . "— SpendTracker";
        Mailer::send($email, 'Verify your SpendTracker email', $body);
    }

    /**
     * Verify the signed-in user's email with the 6-digit code. Idempotent if
     * already verified. Wrong guesses are counted and the code is burned after
     * MAX_CODE_ATTEMPTS (a resend issues a fresh one).
     *
     * @return array<string, mixed> the public user, now emailVerified
     */
    public static function verifyEmailCode(int $uid, mixed $code): array
    {
        Http::throttle('verify:' . $uid, 20, 900);
        Http::throttle('verify_ip:' . Http::clientIp(), 60, 900);

        $u = DB::one('SELECT id, email, name, password_hash, google_sub, currency, email_verified FROM users WHERE id = ?', [$uid]);
        if ($u === null) {
            throw new ApiError('Not signed in', 401);
        }
        if ((int)$u['email_verified'] === 1) {
            return self::publicUser($u); // already verified — no-op
        }

        $code = is_string($code) ? trim($code) : (is_int($code) ? (string)$code : '');
        if (!preg_match('/^\d{6}$/', $code)) {
            throw new ApiError('Enter the 6-digit code from your email', 422);
        }

        $row = DB::one('SELECT id, code_hash, attempts, expires_at FROM email_verifications WHERE user_id = ?', [$uid]);
        if ($row === null || (int)$row['expires_at'] < time()) {
            if ($row !== null) {
                DB::exec('DELETE FROM email_verifications WHERE id = ?', [(int)$row['id']]);
            }
            throw new ApiError('Your code has expired. Request a new one.', 400);
        }
        if ((int)$row['attempts'] >= self::MAX_CODE_ATTEMPTS) {
            DB::exec('DELETE FROM email_verifications WHERE id = ?', [(int)$row['id']]);
            throw new ApiError('Too many incorrect attempts. Request a new code.', 429);
        }
        if (!hash_equals((string)$row['code_hash'], hash('sha256', $code))) {
            DB::exec('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [(int)$row['id']]);
            throw new ApiError('Incorrect code. Please check and try again.', 422);
        }

        DB::exec('UPDATE users SET email_verified = 1 WHERE id = ?', [$uid]);
        DB::exec('DELETE FROM email_verifications WHERE user_id = ?', [$uid]);
        $u['email_verified'] = 1;
        return self::publicUser($u);
    }

    /**
     * Verify via the one-time backup link token from the email. Works with no
     * prior session (the link may be opened on another device); on success the
     * user is signed in, mirroring the reset flow.
     *
     * @return array<string, mixed>
     */
    public static function verifyEmailToken(mixed $token): array
    {
        Http::throttle('verifylink:' . Http::clientIp(), 30, 900);
        $token = is_string($token) ? $token : '';
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
            throw new ApiError('Invalid or expired verification link', 400);
        }

        $hash = hash('sha256', $token);
        $row = DB::one('SELECT id, user_id, expires_at FROM email_verifications WHERE token_hash = ?', [$hash]);
        if ($row === null || (int)$row['expires_at'] < time()) {
            if ($row !== null) {
                DB::exec('DELETE FROM email_verifications WHERE id = ?', [(int)$row['id']]);
            }
            throw new ApiError('This verification link has expired. Please sign in and request a new one.', 400);
        }

        $uid = (int)$row['user_id'];
        DB::exec('UPDATE users SET email_verified = 1 WHERE id = ?', [$uid]);
        DB::exec('DELETE FROM email_verifications WHERE user_id = ?', [$uid]);
        $u = DB::one('SELECT id, email, name, password_hash, google_sub, currency, email_verified FROM users WHERE id = ?', [$uid]);
        assert($u !== null);
        self::establishSession($uid);
        return self::publicUser($u);
    }

    /** Re-issue and re-email a verification code/link for the signed-in user. */
    public static function resendEmailVerification(int $uid): void
    {
        Http::throttle('resend:' . $uid, 5, 900);
        Http::throttle('resend_ip:' . Http::clientIp(), 15, 900);

        $u = DB::one('SELECT id, email, email_verified FROM users WHERE id = ?', [$uid]);
        if ($u === null) {
            throw new ApiError('Not signed in', 401);
        }
        if ((int)$u['email_verified'] === 1) {
            return; // already verified — nothing to send
        }
        self::issueEmailVerification($uid, (string)$u['email']);
    }

    /**
     * Permanently delete the signed-in user's account. The users row is the
     * cascade root — every owned row (accounts, categories, transactions,
     * transfers, budgets, resets, verifications) goes with it. Accounts with a
     * password must re-enter it as the destructive-action confirmation;
     * Google-only accounts are confirmed by their live session alone.
     */
    public static function deleteAccount(int $uid, mixed $currentPassword): void
    {
        Http::throttle('delete_acct:' . $uid, 5, 900);
        $u = DB::one('SELECT id, password_hash FROM users WHERE id = ?', [$uid]);
        if ($u === null) {
            throw new ApiError('Not signed in', 401);
        }
        if ($u['password_hash'] !== null) {
            $current = is_string($currentPassword) ? $currentPassword : '';
            if ($current === '' || !password_verify($current, (string)$u['password_hash'])) {
                throw new ApiError('Password is incorrect', 403);
            }
        }
        DB::exec('DELETE FROM users WHERE id = ?', [$uid]);
        self::logout();
    }

    public static function logout(): void
    {
        $_SESSION = [];
        if ((bool)ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name() ?: 'spendtracker_sid', '', [
                'expires' => time() - 42000,
                'path' => $p['path'],
                'domain' => $p['domain'],
                'secure' => $p['secure'],
                'httponly' => $p['httponly'],
                'samesite' => $p['samesite'],
            ]);
        }
        session_destroy();
    }
}

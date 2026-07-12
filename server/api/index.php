<?php
declare(strict_types=1);

/**
 * SpendTracker API front controller.
 * All /api/* requests are rewritten here (see the docroot .htaccess).
 */

// Buffer all output: a stray BOM/whitespace in an edited config.php would
// otherwise be sent before header() calls and silently break cookies and
// status codes. Http::json() discards anything buffered before responding.
ob_start();

require __DIR__ . '/app/lib/http.php';
require __DIR__ . '/app/lib/db.php';
require __DIR__ . '/app/lib/validate.php';
require __DIR__ . '/app/lib/mailer.php';
require __DIR__ . '/app/lib/auth.php';
require __DIR__ . '/app/lib/repo.php';

$configFile = __DIR__ . '/app/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Server not configured (api/app/config.php is missing)']);
    exit;
}
/** @var array<string, mixed> $config */
$config = require $configFile;

// Pin the timezone so "today" (subscription charge days, budget periods) is
// deterministic instead of inheriting whatever the host's php.ini says. Set
// 'timezone' in config.php to the user base's zone (e.g. 'Asia/Manila').
$tz = (string)($config['timezone'] ?? 'UTC');
if (!@date_default_timezone_set($tz)) {
    date_default_timezone_set('UTC');
}

try {
    Http::init($config);
    DB::init((array)$config['db']);

    $method = $_SERVER['REQUEST_METHOD'];
    $path = (string)(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');
    $route = preg_replace('#^.*?/api(?=/|$)#', '', $path) ?? '';
    $seg = array_values(array_filter(explode('/', $route), static fn(string $s): bool => $s !== ''));
    $resource = $seg[0] ?? '';
    $sub = $seg[1] ?? '';

    // Pre-auth mutations carry no CSRF token, so they get a strict origin
    // check instead; all other mutations require the CSRF token.
    // verify-link carries a token from the email (not a CSRF token) and may be
    // opened on a device with no session, so it's pre-auth (strict origin) like
    // reset. The code-entry `verify` and `resend-verification` are authenticated
    // (the user is signed in but unverified) and keep the normal CSRF check.
    $preAuth = $resource === 'auth' && in_array($sub, ['login', 'register', 'google', 'forgot', 'reset', 'verify-link'], true);
    Http::originCheck($method, $preAuth);
    if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true) && !$preAuth) {
        Http::csrfCheck();
    }

    $googleClientId = (string)($config['google_client_id'] ?? '');

    // ---------- health ----------
    if ($resource === 'health' && $method === 'GET') {
        $dbOk = true;
        try {
            DB::one('SELECT 1 AS ok');
        } catch (Throwable) {
            $dbOk = false;
        }
        Http::json(['ok' => $dbOk, 'php' => PHP_VERSION, 'db' => $dbOk]);
    }

    // ---------- auth ----------
    if ($resource === 'auth') {
        if ($method === 'GET' && $sub === 'me') {
            Http::json([
                'user' => Auth::currentUser(),
                'csrf' => $_SESSION['csrf'],
                'googleClientId' => $googleClientId,
            ]);
        }
        if ($method === 'POST' && $sub === 'register') {
            $b = Http::readJson();
            $user = Auth::register($b['email'] ?? null, $b['password'] ?? null, $b['name'] ?? '', $b['currency'] ?? null);
            Http::json(['user' => $user, 'csrf' => $_SESSION['csrf']]);
        }
        if ($method === 'POST' && $sub === 'login') {
            $b = Http::readJson();
            $user = Auth::login($b['email'] ?? null, $b['password'] ?? null);
            Http::json(['user' => $user, 'csrf' => $_SESSION['csrf']]);
        }
        if ($method === 'POST' && $sub === 'google') {
            $b = Http::readJson();
            $user = Auth::googleSignIn($b['credential'] ?? null, $googleClientId, $b['currency'] ?? null);
            Http::json(['user' => $user, 'csrf' => $_SESSION['csrf']]);
        }
        if ($method === 'POST' && $sub === 'logout') {
            Auth::logout();
            Http::json(['ok' => true]);
        }
        if ($method === 'POST' && $sub === 'forgot') {
            $b = Http::readJson();
            Auth::forgotPassword($b['email'] ?? null);
            // Always the same response, so email addresses can't be probed.
            Http::json(['ok' => true]);
        }
        if ($method === 'POST' && $sub === 'reset') {
            $b = Http::readJson();
            $user = Auth::resetPassword($b['token'] ?? null, $b['password'] ?? null);
            Http::json(['user' => $user, 'csrf' => $_SESSION['csrf']]);
        }
        if ($method === 'POST' && $sub === 'verify') {
            $me = Auth::requireUser(); // signed in (but unverified) + CSRF-checked above
            $b = Http::readJson();
            $user = Auth::verifyEmailCode($me, $b['code'] ?? null);
            Http::json(['user' => $user, 'csrf' => $_SESSION['csrf']]);
        }
        if ($method === 'POST' && $sub === 'verify-link') {
            $b = Http::readJson();
            $user = Auth::verifyEmailToken($b['token'] ?? null); // signs the user in
            Http::json(['user' => $user, 'csrf' => $_SESSION['csrf']]);
        }
        if ($method === 'POST' && $sub === 'resend-verification') {
            $me = Auth::requireUser(); // signed in (but unverified) + CSRF-checked above
            Auth::resendEmailVerification($me);
            Http::json(['ok' => true]);
        }
        if ($method === 'POST' && $sub === 'change-password') {
            $me = Auth::requireUser(); // authenticated + CSRF-checked above
            $b = Http::readJson();
            Auth::changePassword($me, $b['currentPassword'] ?? null, $b['newPassword'] ?? null);
            Http::json(['ok' => true]);
        }
        if ($method === 'POST' && $sub === 'delete-account') {
            // requireUser (not requireVerifiedUser): an unverified signup must
            // still be able to delete itself. CSRF-checked above.
            $me = Auth::requireUser();
            $b = Http::readJson();
            Auth::deleteAccount($me, $b['currentPassword'] ?? null);
            Http::json(['ok' => true]);
        }
        if ($method === 'POST' && $sub === 'currency') {
            $me = Auth::requireUser(); // authenticated + CSRF-checked above
            $b = Http::readJson();
            $currency = Auth::setCurrency($me, $b['currency'] ?? null);
            Http::json(['ok' => true, 'currency' => $currency]);
        }
        throw new ApiError('Not found', 404);
    }

    // Everything below requires a signed-in, email-verified user. (Unverified
    // accounts can still reach the /auth/* routes above — verify, resend,
    // logout, change-password — but no data.)
    $uid = Auth::requireVerifiedUser();

    // Auto-charge any subscriptions that came due, BEFORE handling the
    // request, so every list/report/balance already reflects the charges.
    // (Shared hosting has no reliable cron; charges post on the next visit
    // but are dated their actual due date, so history stays exact.)
    Repo::processDueSubscriptions($uid);

    // ---------- categories ----------
    if ($resource === 'categories') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listCategories($uid));
        }
        if ($method === 'POST' && $sub === '') {
            $b = Http::readJson();
            Http::json(Repo::createCategory($uid, $b['name'] ?? null, $b['type'] ?? null, $b['color'] ?? null), 201);
        }
        if ($method === 'PUT' && $sub !== '') {
            $b = Http::readJson();
            Repo::updateCategory($uid, Validate::intId($sub), $b['name'] ?? null, $b['color'] ?? null);
            Http::json(['ok' => true]);
        }
        if ($method === 'DELETE' && $sub !== '') {
            Repo::deleteCategory($uid, Validate::intId($sub));
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- accounts ----------
    if ($resource === 'accounts') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listAccounts($uid));
        }
        if ($method === 'POST' && $sub === '') {
            // Larger body cap: accounts may carry an inline image data URI.
            $b = Http::readJson(1024 * 1024);
            Http::json(
                Repo::createAccount($uid, $b['name'] ?? null, $b['type'] ?? null, $b['color'] ?? null, $b['openingBalanceCents'] ?? 0, $b['image'] ?? null, $b['dueDay'] ?? null, $b['dueDay2'] ?? null),
                201
            );
        }
        if ($method === 'PUT' && $sub !== '') {
            $b = Http::readJson(1024 * 1024);
            Repo::updateAccount($uid, Validate::intId($sub), $b['name'] ?? null, $b['color'] ?? null, $b['openingBalanceCents'] ?? 0, $b['image'] ?? null, $b['dueDay'] ?? null, $b['dueDay2'] ?? null);
            Http::json(['ok' => true]);
        }
        if ($method === 'DELETE' && $sub !== '') {
            Repo::deleteAccount($uid, Validate::intId($sub));
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- subscriptions ----------
    if ($resource === 'subscriptions') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listSubscriptions($uid));
        }
        if ($method === 'POST' && $sub === '') {
            Http::json(Repo::createSubscription($uid, Http::readJson()), 201);
        }
        if ($method === 'PUT' && $sub !== '') {
            Repo::updateSubscription($uid, Validate::intId($sub), Http::readJson());
            Http::json(['ok' => true]);
        }
        if ($method === 'DELETE' && $sub !== '') {
            Repo::deleteSubscription($uid, Validate::intId($sub));
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- transfers ----------
    if ($resource === 'transfers') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listTransfers($uid, $_GET['month'] ?? null));
        }
        if ($method === 'POST' && $sub === '') {
            Http::json(Repo::createTransfer($uid, Http::readJson()), 201);
        }
        if ($method === 'PUT' && $sub !== '') {
            Repo::updateTransfer($uid, Validate::intId($sub), Http::readJson());
            Http::json(['ok' => true]);
        }
        if ($method === 'DELETE' && $sub !== '') {
            Repo::deleteTransfer($uid, Validate::intId($sub));
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- transactions ----------
    if ($resource === 'transactions') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listTransactions($uid, $_GET));
        }
        if ($method === 'POST' && $sub === '') {
            Http::json(Repo::createTransaction($uid, Http::readJson()), 201);
        }
        if ($method === 'PUT' && $sub !== '') {
            Repo::updateTransaction($uid, Validate::intId($sub), Http::readJson());
            Http::json(['ok' => true]);
        }
        if ($method === 'DELETE' && $sub !== '') {
            Repo::deleteTransaction($uid, Validate::intId($sub));
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- budgets ----------
    if ($resource === 'budgets') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listBudgets($uid));
        }
        if ($method === 'PUT' && $sub === '') {
            $b = Http::readJson();
            Repo::upsertBudget($uid, $b['categoryId'] ?? null, $b['cadence'] ?? null, $b['amountCents'] ?? null);
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- reports ----------
    if ($resource === 'reports' && $method === 'GET') {
        // summary/breakdown accept an explicit ?from=&to= date range; a legacy
        // ?month= is expanded to that month's first/last day.
        $from = $_GET['from'] ?? null;
        $to = $_GET['to'] ?? null;
        if (($from === null || $from === '') && isset($_GET['month'])) {
            [$from, $to] = Repo::monthRange($_GET['month']);
        }
        if ($sub === 'summary') {
            Http::json(Repo::summary($uid, $from, $to));
        }
        if ($sub === 'trend') {
            Http::json(Repo::trend($uid, $_GET['endMonth'] ?? null, $_GET['count'] ?? 6));
        }
        if ($sub === 'breakdown') {
            Http::json(Repo::breakdown($uid, $from, $to, $_GET['type'] ?? null));
        }
        if ($sub === 'years') {
            Http::json(Repo::transactionYears($uid));
        }
        throw new ApiError('Not found', 404);
    }

    throw new ApiError('Not found', 404);
} catch (ApiError $e) {
    Http::json(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('[spendtracker] ' . $e::class . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Http::json(['error' => 'Internal server error'], 500);
}

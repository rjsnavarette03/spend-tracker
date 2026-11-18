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
require __DIR__ . '/app/lib/reminders.php';
require __DIR__ . '/app/lib/reminder_email.php';
require __DIR__ . '/app/lib/assistant.php';

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
    // The reminder-email unsubscribe link is authorized by its token alone and
    // can only turn reminders off, so it skips both checks: mail providers'
    // one-click unsubscribe (RFC 8058) POSTs to it from their own servers,
    // with no session and no Origin or Sec-Fetch-Site.
    $tokenOnly = $resource === 'reminders' && $sub === 'unsubscribe';
    if (!$tokenOnly) {
        Http::originCheck($method, $preAuth);
        if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true) && !$preAuth) {
            Http::csrfCheck();
        }
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

    // ---------- reminder emails: unsubscribe link ----------
    if ($tokenOnly) {
        $token = $_GET['token'] ?? null;
        if ($method === 'GET') {
            // A mail client without one-click support opens the link in a
            // browser: hand over to the app's unsubscribe screen, which asks
            // before turning anything off (link scanners only GET).
            $token = is_string($token) && preg_match('/^[a-f0-9]{64}$/', $token) === 1 ? $token : '';
            header('Location: /?unsubscribe=' . $token, true, 302);
            exit;
        }
        if ($method === 'POST') {
            // One-click POSTs carry the token in the link and a form body;
            // the app's screen sends it as JSON instead.
            if ($token === null) {
                $token = Http::readJson()['token'] ?? null;
            }
            Auth::unsubscribeReminders($token);
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
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
        if ($method === 'POST' && $sub === 'reminders') {
            // Verified only: reminders go to the account's email address.
            // CSRF-checked above.
            $me = Auth::requireVerifiedUser();
            $b = Http::readJson();
            Http::json(['ok' => true] + Auth::setReminders($me, $b['enabled'] ?? null, $b['timezone'] ?? null));
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
        $action = $seg[2] ?? '';
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::listAccounts($uid));
        }
        // Archive a settled account / bring it back (history is never touched).
        if ($method === 'POST' && $sub !== '' && $action === 'archive') {
            Http::json(Repo::archiveAccount($uid, Validate::intId($sub)));
        }
        if ($method === 'POST' && $sub !== '' && $action === 'restore') {
            Repo::restoreAccount($uid, Validate::intId($sub));
            Http::json(['ok' => true]);
        }
        if ($method === 'POST' && $sub === '') {
            // Larger body cap: accounts may carry an inline image data URI.
            $b = Http::readJson(1024 * 1024);
            Http::json(Repo::createAccount($uid, $b), 201);
        }
        if ($method === 'PUT' && $sub !== '') {
            $b = Http::readJson(1024 * 1024);
            Repo::updateAccount($uid, Validate::intId($sub), $b);
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

    // ---------- payment schedule ----------
    if ($resource === 'schedule') {
        $id = $seg[2] ?? '';
        if ($method === 'GET' && $sub === '') {
            Http::json(Repo::getSchedule($uid));
        }
        if ($sub === 'items') {
            if ($method === 'POST' && $id === '') {
                Http::json(Repo::createScheduleItem($uid, Http::readJson()), 201);
            }
            if ($method === 'PUT' && $id !== '') {
                Repo::updateScheduleItem($uid, Validate::intId($id), Http::readJson());
                Http::json(['ok' => true]);
            }
            if ($method === 'DELETE' && $id !== '') {
                Repo::deleteScheduleItem($uid, Validate::intId($id));
                Http::json(['ok' => true]);
            }
        }
        if ($method === 'POST' && $sub === 'pay') {
            Http::json(Repo::paySchedule($uid, Http::readJson()), 201);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- importing a bank statement ----------
    if ($resource === 'import') {
        $id = $seg[2] ?? '';
        if ($method === 'POST' && $sub === '') {
            // Larger body cap: up to 1,000 rows.
            Http::json(Repo::importTransactions($uid, Http::readJson(1024 * 1024)), 201);
        }
        if ($sub === 'rules') {
            if ($method === 'GET' && $id === '') {
                Http::json(Repo::listImportRules($uid));
            }
            if ($method === 'POST' && $id === '') {
                Http::json(Repo::saveImportRule($uid, Http::readJson()), 201);
            }
            if ($method === 'DELETE' && $id !== '') {
                Repo::deleteImportRule($uid, Validate::intId($id));
                Http::json(['ok' => true]);
            }
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
        // Split receipts (one receipt across categories); before the plain
        // routes, which would take /transactions/:id/split as /transactions/:id.
        if ($method === 'POST' && $sub === 'split') {
            Http::json(Repo::createSplit($uid, Http::readJson()), 201);
        }
        if ($sub !== '' && ($seg[2] ?? '') === 'split') {
            if ($method === 'PUT') {
                Http::json(Repo::updateSplit($uid, Validate::intId($sub), Http::readJson()));
            }
            if ($method === 'DELETE') {
                Repo::deleteSplit($uid, Validate::intId($sub));
                Http::json(['ok' => true]);
            }
            throw new ApiError('Not found', 404);
        }
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
            Repo::upsertBudget(
                $uid,
                $b['categoryId'] ?? null,
                $b['cadence'] ?? null,
                $b['amountCents'] ?? null,
                $b['rollover'] ?? null,
                $b['rolloverFrom'] ?? null
            );
            Http::json(['ok' => true]);
        }
        throw new ApiError('Not found', 404);
    }

    // ---------- AI assistant (the dashboard's chat) ----------
    if ($resource === 'assistant') {
        if ($method === 'GET' && $sub === '') {
            Http::json(Assistant::status($uid));
        }
        if ($method === 'POST' && $sub === 'chat') {
            // The browser sends the recent conversation with each question.
            Http::json(Assistant::chat($uid, Http::readJson(256 * 1024)['messages'] ?? null));
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
        if ($sub === 'networth') {
            Http::json(Repo::netWorthHistory($uid, $_GET['months'] ?? 12));
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

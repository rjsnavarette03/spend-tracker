<?php
declare(strict_types=1);

/**
 * Daily reminder emails. Run it every hour from cron (hPanel → Advanced →
 * Cron Jobs), with the PHP 8.3 CLI:
 *   /opt/alt/php83/usr/bin/php <public_html>/api/app/cron/send-reminders.php
 *
 * For each email-verified user with reminder emails on, once it's 7 AM or
 * later where they are (users.timezone) and they haven't been checked today:
 * charge any subscriptions that came due (as every app visit does — a stale
 * charge date would otherwise read as overdue), work out what the bell shows
 * (Reminders::build), and if any of it hasn't been emailed at its current
 * stage yet, email the whole list. At most one email per user per local day;
 * a send that fails is retried the next hour. Lives in app/, which the web
 * server refuses to serve.
 *
 *   --dry-run    print what would be sent; send, charge and record nothing
 *   --user=ID    only this user
 *   --now=TIME   act as if it's TIME, e.g. 2026-10-29T07:30:00+08:00 (testing)
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$app = dirname(__DIR__);
require $app . '/lib/http.php';
require $app . '/lib/db.php';
require $app . '/lib/validate.php';
require $app . '/lib/mailer.php';
require $app . '/lib/auth.php';
require $app . '/lib/repo.php';
require $app . '/lib/reminders.php';
require $app . '/lib/reminder_email.php';

if (!is_file($app . '/config.php')) {
    fwrite(STDERR, "Server not configured (api/app/config.php is missing)\n");
    exit(1);
}
/** @var array<string, mixed> $config */
$config = require $app . '/config.php';
// Same server "today" as the API (subscription charges, the schedule's windows).
if (!@date_default_timezone_set((string)($config['timezone'] ?? 'UTC'))) {
    date_default_timezone_set('UTC');
}
Http::initCli($config);
DB::init((array)$config['db']);

$opts = getopt('', ['dry-run', 'user:', 'now:']);
$dryRun = isset($opts['dry-run']);
$onlyUser = isset($opts['user']) ? (int)$opts['user'] : null;
try {
    $now = new DateTimeImmutable(isset($opts['now']) ? (string)$opts['now'] : 'now');
} catch (Exception) {
    fwrite(STDERR, "Can't read --now={$opts['now']}\n");
    exit(1);
}

// Run from cron there's no web host to fall back on, so mail would go out
// from noreply@localhost — which receiving servers reject or junk.
if (!$dryRun && (string)($config['mail_log_file'] ?? '') === '' && trim((string)($config['mail_from'] ?? '')) === '') {
    fwrite(STDERR, "Set 'mail_from' in api/app/config.php (a real mailbox on the domain) before sending reminders.\n");
    exit(1);
}

if (!$dryRun) {
    DB::exec('DELETE FROM reminder_sends WHERE sent_on < ?', [date('Y-m-d', strtotime('-90 days'))]);
}

$sql = 'SELECT id, email, name, currency, timezone, reminders_run_on, reminder_token
        FROM users WHERE reminder_emails = 1 AND email_verified = 1';
$params = [];
if ($onlyUser !== null) {
    $sql .= ' AND id = ?';
    $params[] = $onlyUser;
}
$users = DB::all($sql . ' ORDER BY id', $params);

$failed = 0;
foreach ($users as $u) {
    $uid = (int)$u['id'];
    try {
        $zone = new DateTimeZone((string)$u['timezone']);
    } catch (Exception) {
        $zone = new DateTimeZone(date_default_timezone_get());
    }
    $local = $now->setTimezone($zone);
    $today = $local->format('Y-m-d');
    $tag = "user $uid, " . $local->format('D Y-m-d H:i') . ' ' . $zone->getName();
    $lastRun = $u['reminders_run_on'] === null ? null : (string)$u['reminders_run_on'];

    if ((int)$local->format('G') < ReminderEmail::SEND_HOUR) {
        echo "$tag: before " . ReminderEmail::SEND_HOUR . " AM, not yet\n";
        continue;
    }
    if ($lastRun !== null && $lastRun >= $today) {
        echo "$tag: already checked today\n";
        continue;
    }
    // Claim the day first, so two overlapping runs can't both send.
    if (!$dryRun) {
        $claimed = DB::exec(
            'UPDATE users SET reminders_run_on = ? WHERE id = ? AND (reminders_run_on IS NULL OR reminders_run_on < ?)',
            [$today, $uid, $today]
        );
        if ($claimed === 0) {
            echo "$tag: already checked today\n";
            continue;
        }
    }

    try {
        if (!$dryRun) {
            Repo::processDueSubscriptions($uid);
        }
        $reminders = Reminders::build(Repo::getSchedule($uid), Repo::listAccounts($uid), Repo::listSubscriptions($uid), $today);
        $emailed = array_column(DB::all('SELECT reminder_key FROM reminder_sends WHERE user_id = ?', [$uid]), 'reminder_key');
        $new = array_values(array_diff(array_column($reminders, 'key'), $emailed));
        $count = count($reminders) . (count($reminders) === 1 ? ' reminder' : ' reminders');
        if ($new === []) {
            echo "$tag: $count, none new, no email\n";
            continue;
        }

        $token = (string)($u['reminder_token'] ?? '');
        if ($token === '') {
            $token = bin2hex(random_bytes(32));
            if (!$dryRun) {
                DB::exec('UPDATE users SET reminder_token = ? WHERE id = ?', [$token, $uid]);
            }
        }
        $mail = ReminderEmail::daily($u, $reminders, $today, $token);
        $summary = "$count (" . count($new) . ' new)';
        if ($dryRun) {
            echo "$tag: would send $summary\n  Subject: {$mail['subject']}\n\n" . $mail['body'] . "\n\n";
            continue;
        }
        if (!Mailer::send((string)$u['email'], $mail['subject'], $mail['body'], $mail['headers'])) {
            throw new RuntimeException('the mail server did not accept the email');
        }
        foreach ($new as $key) {
            DB::exec('INSERT INTO reminder_sends (user_id, reminder_key, sent_on) VALUES (?, ?, ?)', [$uid, $key, $today]);
        }
        echo "$tag: sent $summary\n";
    } catch (Throwable $e) {
        $failed++;
        // Hand the day back, so the next hourly run tries again.
        if (!$dryRun) {
            DB::exec('UPDATE users SET reminders_run_on = ? WHERE id = ?', [$lastRun, $uid]);
        }
        fwrite(STDERR, "$tag: failed, will retry next hour: " . $e->getMessage() . "\n");
        error_log('[spendtracker reminders] user ' . $uid . ': ' . $e::class . ': ' . $e->getMessage());
    }
}

exit($failed === 0 ? 0 : 1);

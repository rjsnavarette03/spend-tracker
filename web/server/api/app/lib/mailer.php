<?php
declare(strict_types=1);

final class Mailer
{
    /**
     * Send a plain-text email. In production this uses PHP mail(); when the
     * config sets 'mail_log_file' (local dev/tests) the message is appended to
     * that file instead of being sent, so the reset flow is testable offline.
     */
    public static function send(string $to, string $subject, string $body): bool
    {
        $from = (string)Http::config('mail_from', 'noreply@' . self::hostOnly());
        $logFile = Http::config('mail_log_file');

        if (is_string($logFile) && $logFile !== '') {
            $entry = "TO: $to\nFROM: $from\nSUBJECT: $subject\n\n$body\n----\n";
            return file_put_contents($logFile, $entry, FILE_APPEND | LOCK_EX) !== false;
        }

        $headers = [
            'From: SpendTracker <' . $from . '>',
            'Reply-To: ' . $from,
            'Content-Type: text/plain; charset=utf-8',
            'MIME-Version: 1.0',
            'X-Mailer: SpendTracker',
        ];
        // -f sets the envelope sender so the host's MTA accepts it.
        return @mail($to, $subject, $body, implode("\r\n", $headers), '-f' . $from);
    }

    private static function hostOnly(): string
    {
        $host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? 'localhost') ?? 'localhost');
        return $host === '' ? 'localhost' : $host;
    }

    public static function appBaseUrl(): string
    {
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        $scheme = $https ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        return $scheme . '://' . $host;
    }
}

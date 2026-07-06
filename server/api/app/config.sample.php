<?php
/**
 * SpendTracker server configuration.
 * Copy this file to config.php (same folder) and fill in your values.
 * config.php is blocked from direct web access by the .htaccess here.
 */
return [
    'db' => [
        // Hostinger MySQL (hPanel -> Databases -> Management):
        'dsn' => 'mysql:host=localhost;dbname=YOUR_DB_NAME;charset=utf8mb4',
        'user' => 'YOUR_DB_USER',
        'pass' => 'YOUR_DB_PASSWORD',

        // For local testing with SQLite instead, comment the three lines
        // above and use:
        // 'dsn' => 'sqlite:' . __DIR__ . '/data.sqlite',
    ],

    // Google OAuth Client ID (Web application) from
    // https://console.cloud.google.com/apis/credentials
    // Leave empty ('') to hide the Google sign-in button.
    'google_client_id' => '',

    // "From" address for password-reset emails. For best deliverability this
    // should be a real mailbox on your domain (hPanel -> Emails). If omitted,
    // it defaults to noreply@<your-domain>.
    'mail_from' => 'noreply@budgettracker.rjsnavarette.com',

    // Session cookie name (no need to change).
    'session_name' => 'spendtracker_sid',
];

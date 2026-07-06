<?php
/**
 * Router for the PHP built-in server (local testing only — production uses
 * .htaccess). Run from the assembled deploy folder:
 *   php -S 127.0.0.1:8124 router.php
 */
$path = (string)parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$docroot = __DIR__;

if (preg_match('#^/api(/|$)#', $path)) {
    require $docroot . '/api/index.php';
    return true;
}

$file = realpath($docroot . $path);
if ($file !== false && is_file($file) && str_starts_with($file, (string)realpath($docroot))) {
    return false; // let the built-in server serve the static file
}

// SPA fallback
header('Content-Type: text/html; charset=utf-8');
readfile($docroot . '/index.html');
return true;
